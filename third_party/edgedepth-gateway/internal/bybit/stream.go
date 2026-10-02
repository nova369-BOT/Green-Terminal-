package bybit

import (
	"context"
	"encoding/json"
	"log/slog"
	"math/rand"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// WSBase is the Bybit v5 public linear WebSocket endpoint. Override for
// testnet (wss://stream-testnet.bybit.com/v5/public/linear).
var WSBase = "wss://stream.bybit.com/v5/public/linear"

// Envelope is the wrapper around every data push: topic + type + data.
// Operation replies (subscribe acks, pongs) carry "op" instead and no topic.
type Envelope struct {
	Topic string          `json:"topic"`
	Type  string          `json:"type"` // "snapshot" | "delta"
	TS    int64           `json:"ts"`
	Data  json.RawMessage `json:"data"`
	CTS   int64           `json:"cts"`
}

// opReply is a subscribe ack or pong: {"op":"subscribe","success":true,...}
// or {"op":"pong",...}. Some pongs arrive as {"ret_msg":"pong",...}.
type opReply struct {
	Op      string `json:"op"`
	Success *bool  `json:"success"`
	RetMsg  string `json:"ret_msg"`
}

// Stream is a self-healing multiplexed connection to the Bybit v5 public
// WebSocket. It reconnects with jittered exponential backoff and replays its
// subscriptions on every (re)connect.
type Stream struct {
	topics  []string
	onMsg   func(Envelope)
	onReset func() // called after every (re)connect so callers can resync state

	log *slog.Logger

	// conn is the live connection, retained so Reconnect can force a
	// re-dial. Bybit's orderbook stream has no REST replay procedure: on a
	// sequence gap the ONLY way back to a correct book is a fresh
	// subscription, which delivers a fresh snapshot.
	mu   sync.Mutex
	conn *websocket.Conn
}

// NewStream builds a stream for the given topics, e.g.
// "publicTrade.BTCUSDT". onReset fires after each successful connect,
// including reconnects: any state derived from a continuous sequence must be
// rebuilt there.
func NewStream(topics []string, log *slog.Logger, onMsg func(Envelope), onReset func()) *Stream {
	return &Stream{topics: topics, onMsg: onMsg, onReset: onReset, log: log}
}

// Reconnect drops the current connection, forcing Run's loop to dial again
// and resubscribe. Used by the feed when the orderbook sequence gaps: the
// fresh subscription's snapshot is the resync.
func (s *Stream) Reconnect() {
	s.mu.Lock()
	c := s.conn
	s.conn = nil
	s.mu.Unlock()
	if c != nil {
		_ = c.Close()
	}
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
			s.log.Warn("bybit stream dropped, reconnecting",
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
	s.mu.Lock()
	s.conn = conn
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if s.conn == conn {
			s.conn = nil
		}
		s.mu.Unlock()
		_ = conn.Close()
	}()
	done := make(chan struct{})
	defer close(done)

	sub, err := json.Marshal(map[string]any{"op": "subscribe", "args": s.topics})
	if err != nil {
		return err
	}
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if err := conn.WriteMessage(websocket.TextMessage, sub); err != nil {
		return err
	}

	s.log.Info("bybit stream connected", "topics", len(s.topics))
	if s.onReset != nil {
		s.onReset()
	}

	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Minute))

	// Bybit's documented keepalive is an application-level {"op":"ping"}
	// every ~20s; the server answers with an op pong. Idle sockets are
	// dropped without it.
	var writeMu sync.Mutex
	go func() {
		tick := time.NewTicker(20 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-done:
				return
			case <-tick.C:
				writeMu.Lock()
				_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"op":"ping"}`))
				writeMu.Unlock()
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
			s.log.Debug("bybit stream: unparsable frame", "err", err)
			continue
		}
		if env.Topic == "" {
			// Subscribe ack or pong. A failed subscribe is worth surfacing:
			// it is how a typo'd topic turns into a panel that never fills.
			var op opReply
			if json.Unmarshal(raw, &op) == nil &&
				op.Op == "subscribe" && op.Success != nil && !*op.Success {
				s.log.Warn("bybit subscribe rejected", "ret_msg", op.RetMsg)
			}
			continue
		}
		s.onMsg(env)
	}
}
