package hyperliquid

import (
	"context"
	"encoding/json"
	"log/slog"
	"math/rand"
	"time"

	"github.com/gorilla/websocket"
)

// WSBase is the Hyperliquid WebSocket endpoint. Override for testnet.
var WSBase = "wss://api.hyperliquid.xyz/ws"

// Subscription is one channel request, sent as
// {"method":"subscribe","subscription":{...}}. Several subscriptions ride one
// connection; frames are demultiplexed by their channel name.
type Subscription struct {
	Type     string `json:"type"`
	Coin     string `json:"coin,omitempty"`
	Interval string `json:"interval,omitempty"`
	Dex      string `json:"dex,omitempty"`
}

// Envelope is the wrapper around every message: subscription acks and data
// frames alike carry channel + data.
type Envelope struct {
	Channel string          `json:"channel"`
	Data    json.RawMessage `json:"data"`
}

// Stream is a self-healing multiplexed connection to the Hyperliquid
// WebSocket. It reconnects with jittered exponential backoff and replays its
// subscriptions on every (re)connect.
type Stream struct {
	subs    []Subscription
	onMsg   func(channel string, data json.RawMessage)
	onReset func() // called after every (re)connect so callers can resync state

	log *slog.Logger
}

// NewStream builds a stream for the given subscriptions, e.g.
// {Type:"trades", Coin:"BTC"}. onReset fires after each successful connect,
// including reconnects: any state derived from a continuous sequence must be
// rebuilt there.
func NewStream(subs []Subscription, log *slog.Logger, onMsg func(string, json.RawMessage), onReset func()) *Stream {
	return &Stream{subs: subs, onMsg: onMsg, onReset: onReset, log: log}
}

// Run blocks until ctx is cancelled, keeping the connection alive throughout.
func (s *Stream) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		start := time.Now()
		err := s.dial(ctx)
		if ctx.Err() != nil {
			return
		}
		// A connection that survived a while then dropped is normal. Only
		// escalate backoff on fast failures, which is what a real outage or
		// a bad subscription looks like.
		if time.Since(start) > time.Minute {
			backoff = time.Second
		}
		if err != nil {
			s.log.Warn("hyperliquid stream dropped, reconnecting",
				"err", err, "backoff", backoff.String())
		}
		jitter := time.Duration(rand.Int63n(int64(backoff/2 + 1)))
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff + jitter):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func (s *Stream) dial(ctx context.Context) error {
	dialCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	conn, _, err := websocket.DefaultDialer.DialContext(dialCtx, WSBase, nil)
	if err != nil {
		return err
	}
	defer conn.Close()
	done := make(chan struct{})
	defer close(done)

	for _, sub := range s.subs {
		msg, err := json.Marshal(map[string]any{"method": "subscribe", "subscription": sub})
		if err != nil {
			return err
		}
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			return err
		}
	}

	s.log.Info("hyperliquid stream connected", "subs", len(s.subs))
	if s.onReset != nil {
		s.onReset()
	}

	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Minute))
	conn.SetPingHandler(func(appData string) error {
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Minute))
		return conn.WriteControl(websocket.PongMessage, []byte(appData),
			time.Now().Add(10*time.Second))
	})

	// Application-level keepalive on top of the WS ping/pong: an idle socket
	// still proves it is alive every 30s.
	go func() {
		tick := time.NewTicker(30 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-done:
				return
			case <-tick.C:
				_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"method":"ping"}`))
			}
		}
	}()

	go func() {
		select {
		case <-ctx.Done():
			_ = conn.Close()
		case <-done:
		}
	}()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Minute))
		var env Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			s.log.Debug("hyperliquid stream: unparsable frame", "err", err)
			continue
		}
		// Subscription acks and pong replies carry no market data.
		if env.Channel == "" || env.Channel == "subscriptionResponse" || env.Channel == "pong" {
			continue
		}
		s.onMsg(env.Channel, env.Data)
	}
}
