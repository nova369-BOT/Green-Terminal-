#pragma once
#include <string>
#include <algorithm>
#include <cctype>
#include <cstdlib>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

// Route shape: /terminal/<venue>/<symbol>, where venue is one of the hub's
// exchange ids (binancef | bybit | hl). That is the CANONICAL form and the
// only one the builder emits. Two legacy shapes still parse, because every
// bookmark, marketing link, lesson deep link and research report written
// before 2026-09-19 uses them, and none of those may break:
//
//   /terminal/<symbol>                 -> binancef (the venue-less alias)
//   /terminal/<symbol>?exchange=<ex>   -> the query-carried venue
//
// Boot normalizes an alias to the canonical path with url_push, so the
// address bar shows one shape. The venue moved INTO the path because a query
// param is route-owned state living outside the route: every builder that
// only knew a symbol silently produced a Binance link, and url_navigate
// deliberately strips ?exchange= on a symbol click. With the venue in the
// path a symbol alone is not an address, so that class of bug cannot recur.
//
// Query-string discipline: neither the boot normalization (url_push) nor a
// symbol navigation (url_navigate) may eat the user's query params. ?ws= is
// the load-bearing one: a self-hoster pointing the terminal at their own
// gateway would otherwise lose the override on boot or on the first watchlist
// click and silently reconnect to the production feed. Route-owned keys
// (exchange) and one-shot deep links (pack/packsym/packt/t/lesson/event) are
// dropped on NAVIGATION, because a symbol click is an intent to leave those
// modes; everything else is carried over. Everything here is EM_ASM, not
// EM_JS, so this header is safe to include from any translation unit.

struct Route {
    std::string symbol;
    std::string exchange;

    Route() : exchange("binancef") {}
};

inline std::string url_get_current_path() {
#ifdef __EMSCRIPTEN__
    char* raw = reinterpret_cast<char*>(EM_ASM_PTR({
        var path = window.location.pathname;
        var len = lengthBytesUTF8(path) + 1;
        var buf = _malloc(len);
        stringToUTF8(path, buf, len);
        return buf;
    }));
    std::string path(raw);
    free(raw);
    return path;
#else
    return "/terminal/binancef/btcusdt";
#endif
}

inline std::string url_get_current_search() {
#ifdef __EMSCRIPTEN__
    char* raw = reinterpret_cast<char*>(EM_ASM_PTR({
        var s = window.location.search;
        var len = lengthBytesUTF8(s) + 1;
        var buf = _malloc(len);
        stringToUTF8(s, buf, len);
        return buf;
    }));
    std::string s(raw);
    free(raw);
    return s;
#else
    return "";
#endif
}

// pushState to path, merging the current query string (the path's own query
// wins per key). Boot uses this to normalize / and the legacy aliases into
// /terminal/<venue>/<symbol>. The legacy ?exchange= is dropped here: the path
// now carries the venue, and leaving the query copy behind would let the two
// disagree on the next navigation.
inline void url_push(const std::string& path) {
#ifdef __EMSCRIPTEN__
    EM_ASM({
        var p = UTF8ToString($0);
        var qi = p.indexOf('?');
        var params = new URLSearchParams(window.location.search);
        params.delete('exchange');
        if (qi >= 0) {
            new URLSearchParams(p.slice(qi + 1)).forEach(function(v, k) {
                params.set(k, v);
            });
            p = p.slice(0, qi);
        }
        var oldPath = window.location.pathname;
        var marketChanged = (oldPath.indexOf('/terminal/binancef/') === 0 || oldPath.indexOf('/terminal/bybit/') === 0 || oldPath.indexOf('/terminal/hl/') === 0) && oldPath !== p;
        if (marketChanged) 'compression compressionId peak touch'.split(' ').forEach(function(k) { params.delete(k); });
        var q = params.toString();
        var url = q ? p + '?' + q : p;
        if (window.location.pathname + window.location.search !== url) {
            window.history.pushState({}, "", url);
            if (marketChanged) window.dispatchEvent(new CustomEvent("edgedepth:market-changed"));
        }
    }, path.c_str());
#else
    (void)path;  // native builds (the unit tests) have no history to push
#endif
}

// Full navigation to path (reloads the app). Carries the query string over,
// minus route-owned and one-shot deep-link keys; the path's own query wins.
inline void url_navigate(const std::string& path) {
#ifdef __EMSCRIPTEN__
    EM_ASM({
        var p = UTF8ToString($0);
        var qi = p.indexOf('?');
        var params = new URLSearchParams(window.location.search);
        // split(' ') instead of an array literal: EM_ASM is a C macro and the
        // preprocessor would treat the literal's commas as argument breaks.
        'exchange pack packsym packt t lesson event compression compressionId peak touch'.split(' ')
            .forEach(function(k) { params.delete(k); });
        if (qi >= 0) {
            new URLSearchParams(p.slice(qi + 1)).forEach(function(v, k) {
                params.set(k, v);
            });
            p = p.slice(0, qi);
        }
        var q = params.toString();
        window.location.href = q ? p + '?' + q : p;
    }, path.c_str());
#else
    (void)path;  // native builds (the unit tests) have nowhere to navigate
#endif
}

inline void url_register_popstate() {
#ifdef __EMSCRIPTEN__
    EM_ASM({
        window.addEventListener("popstate", function() {
            if (Module._on_popstate) {
                Module._on_popstate();
            }
        });
    });
#endif
}

// Read one whole query-string key. This deliberately walks key/value pairs
// instead of searching for a substring: "surface" must not match
// "old_surface", and text in another parameter's value is not a key. Values
// stay case-preserved; callers that own case folding do it explicitly.
inline std::string parse_query_value(const std::string& search, const std::string& key) {
    using size_type = std::string::size_type;
    size_type pos = 0;
    while (pos < search.size()) {
        if (search[pos] == '?' || search[pos] == '&') { ++pos; continue; }

        const size_type amp = search.find('&', pos);
        const size_type end = (amp == std::string::npos) ? search.size() : amp;
        const size_type eq  = search.find('=', pos);

        if (eq != std::string::npos && eq < end &&
            search.compare(pos, eq - pos, key) == 0) {
            return search.substr(eq + 1, end - eq - 1);
        }
        pos = end + 1;
    }
    return "";
}

// Extract a lowercased ?exchange=<ex> value from a query string (e.g.
// "?exchange=hl&foo=1"); returns "" when absent.
inline std::string parse_exchange_query(const std::string& search) {
    std::string ex = parse_query_value(search, "exchange");
    std::transform(ex.begin(), ex.end(), ex.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return ex;
}

// Extract a case-PRESERVED ?symbol=<sym> value from a query string (e.g.
// "?exchange=hl&symbol=BTC"); returns "" when absent. Case is preserved here
// because Hyperliquid coins are uppercase end-to-end; the caller normalizes
// per venue, mirroring parse_route. GREEN TERMINAL embed patch: the GT shell
// boots the engine at /edgedepth/index.html?exchange=..&symbol=.. (not a
// /terminal/ path), so the symbol must be readable from the query too.
inline std::string parse_symbol_query(const std::string& search) {
    return parse_query_value(search, "symbol");
}

// The venues the hub serves, by their exchange id. This is the ONLY list the
// router consults: a first path segment is a venue iff it is in here, so a
// symbol can never be mistaken for a venue and a typo'd venue never routes
// anywhere. Mirrors markets.IsVenue in the Go backend.
inline bool is_known_exchange(const std::string& ex) {
    return ex == "binancef" || ex == "bybit" || ex == "hl";
}

// Symbol case is venue dependent: Binance and Bybit product symbols are
// lowercase end-to-end (the hub lowercases both in normalizePair); Hyperliquid
// coins keep native case ("BTC", "kPEPE") because their subjects and DB rows
// do. One helper so boot, the studio symbol and the router agree.
inline std::string normalize_symbol_case(const std::string& exchange, std::string symbol) {
    if (exchange == "binancef" || exchange == "bybit") {
        std::transform(symbol.begin(), symbol.end(), symbol.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    }
    return symbol;
}

// Decode one path segment: percent-escapes once, malformed escapes kept
// literally, a decoded slash never reinterpreted as routing.
inline std::string url_decode_segment(const std::string& seg) {
    std::string decoded;
    const auto hex = [](unsigned char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    for (size_t i = 0; i < seg.size(); ++i) {
        if (seg[i] == '%' && i + 2 < seg.size()) {
            const int hi = hex(seg[i + 1]), lo = hex(seg[i + 2]);
            if (hi >= 0 && lo >= 0 && (hi || lo)) {
                decoded += static_cast<char>((hi << 4) | lo);
                i += 2;
                continue;
            }
        }
        decoded += seg[i];
    }
    return decoded;
}

// parse_route reads /terminal/<venue>/<symbol> (canonical), or the legacy
// /terminal/<symbol> with the venue defaulting to binancef unless an
// ?exchange=<ex> query names one. The exchange is resolved BEFORE the symbol
// is cased (see normalize_symbol_case). A path-carried venue wins over the
// query: the path is the address, the query is a leftover.
inline Route parse_route(const std::string& path, const std::string& search = "") {
    Route r;

    const std::string ex = parse_exchange_query(search);
    if (!ex.empty()) r.exchange = ex;

    const std::string prefix = "/terminal/";
    if (path.rfind(prefix, 0) != 0) return r;

    std::string rest = path.substr(prefix.size());
    if (!rest.empty() && rest.back() == '/') rest.pop_back();
    if (rest.empty()) return r;

    // Split the path once; decode each segment after splitting.
    const auto slash = rest.find('/');
    std::string first = url_decode_segment(rest.substr(0, slash));
    std::string first_lower = first;
    std::transform(first_lower.begin(), first_lower.end(), first_lower.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });

    if (slash != std::string::npos && is_known_exchange(first_lower)) {
        // Canonical: /terminal/<venue>/<symbol>[/ignored]
        r.exchange = first_lower;
        const std::string tail = rest.substr(slash + 1);
        const auto next = tail.find('/');
        r.symbol = url_decode_segment(tail.substr(0, next));
    } else {
        // Alias: /terminal/<symbol>[/ignored], venue from the query or default.
        r.symbol = std::move(first);
    }
    if (r.symbol.empty()) return r;

    r.symbol = normalize_symbol_case(r.exchange, r.symbol);
    return r;
}

// Canonical terminal path: /terminal/<venue>/<symbol>. An unset venue means
// binancef. There is deliberately no symbol-only overload any more: a symbol
// is not an address, and the overload was how venue-less links got minted.
inline std::string build_terminal_path(const std::string& exchange, const std::string& symbol) {
    return "/terminal/" + (exchange.empty() ? std::string("binancef") : exchange) + "/" + symbol;
}

// Embed flag: ?watchlist=0 boots the terminal WITHOUT the Watchlist rail.
// Green Terminal's G-Flow dock sets it because GT already owns the market
// list; a second in-frame watchlist would be a competing source of truth
// for "what can I click" (unification: one watchlist). Non-route-owned, so
// url_push/url_navigate carry it across boots and symbol switches and the
// rail stays hidden for the whole embedded session. Nothing is removed from
// the terminal itself: standalone boots are unaffected and the +Widget menu
// can still add a Watchlist explicitly even when this flag is present.
inline bool url_watchlist_disabled() {
#ifdef __EMSCRIPTEN__
    return EM_ASM_INT({
        return /[?&]watchlist=0(?:&|$)/.test(window.location.search) ? 1 : 0;
    }) != 0;
#else
    return false;  // native builds (the unit tests) always keep the rail
#endif
}

// Embed flag: ?rt=0 hides the Real-time toolbar PILL — and only the pill.
// Green Terminal's G-Flow dock sets it because the host carries its own
// Real-time button; the RT display itself stays fully functional and is
// driven by the host through the window.__gtRtCmd bridge (see main_loop
// in main.cpp). Standalone boots are unaffected.
inline bool url_rt_disabled() {
#ifdef __EMSCRIPTEN__
    return EM_ASM_INT({
        return /[?&]rt=0(?:&|$)/.test(window.location.search) ? 1 : 0;
    }) != 0;
#else
    return false;  // native builds (the unit tests) keep RT available
#endif
}

// Embed flag: ?tf=0 hides EdgeDepth's timeframe selector. Green Terminal owns
// the visible timeframe rail and already drives the same ChartWidget method
// through Module.__set_chart_timeframe. The hidden control's non-visual bridge
// work (notably host-requested Real-time settings) remains active.
inline bool url_timeframe_disabled() {
#ifdef __EMSCRIPTEN__
    return EM_ASM_INT({
        return /[?&]tf=0(?:&|$)/.test(window.location.search) ? 1 : 0;
    }) != 0;
#else
    return false;
#endif
}

// Embed flag: ?ctypes=flow keeps only EdgeDepth-exclusive order-flow views in
// the chart-type menu. Price views remain implemented and continue to render
// when restored from a workspace; only their duplicate embed menu rows hide.
inline bool url_flow_chart_types_only() {
#ifdef __EMSCRIPTEN__
    return EM_ASM_INT({
        return /[?&]ctypes=flow(?:&|$)/.test(window.location.search) ? 1 : 0;
    }) != 0;
#else
    return false;
#endif
}

// Embed flag: ?draw=0 hides EdgeDepth's drawing-control entry points while it
// is docked in Green Terminal. Existing drawings and the drawing render layer
// stay intact; standalone boots retain the complete drawing suite.
inline bool url_drawing_controls_disabled() {
#ifdef __EMSCRIPTEN__
    return EM_ASM_INT({
        return /[?&]draw=0(?:&|$)/.test(window.location.search) ? 1 : 0;
    }) != 0;
#else
    return false;
#endif
}

// Embed flag: ?ind=flow removes only the duplicate standard-indicator menu
// rows (Volume, RSI and MACD). EdgeDepth-exclusive flow indicators remain
// available, and already-active standard indicators continue to render.
inline bool url_standard_indicators_disabled() {
#ifdef __EMSCRIPTEN__
    return EM_ASM_INT({
        return /[?&]ind=flow(?:&|$)/.test(window.location.search) ? 1 : 0;
    }) != 0;
#else
    return false;
#endif
}

// Embed flag: ?brand=0 hides only EdgeDepth's in-frame product wordmark. The
// market pill, navigation, workspace, replay, settings and account controls
// remain available. Green Terminal supplies the single outer product identity.
inline bool url_brand_disabled() {
#ifdef __EMSCRIPTEN__
    return EM_ASM_INT({
        return /[?&]brand=0(?:&|$)/.test(window.location.search) ? 1 : 0;
    }) != 0;
#else
    return false;
#endif
}

// Green Terminal's integrated PRICE & CHART dock has two mutually exclusive
// EdgeDepth surfaces. `surface=flow` is the lean companion: real DOM, depth
// and tape only, with no second price chart. Omitting it keeps the complete
// EdgeDepth workspace for the explicit Workspace/Real-time takeover. The mode
// is fixed for a document lifetime (the host changes it with a navigation), so
// cache the query result and avoid a JS boundary crossing every frame.
inline bool url_flow_surface() {
#ifdef __EMSCRIPTEN__
    static const bool value =
        parse_query_value(url_get_current_search(), "surface") == "flow";
    return value;
#else
    return false;
#endif
}

// Non-visual host contract. Unlike ?rt=0 this does not hide any native
// controls; it only enables the existing Green Terminal command/ack bridge.
// The full Workspace surface uses it so the host can enter native Real-time
// before its own chart chrome steps aside.
inline bool url_green_terminal_host() {
#ifdef __EMSCRIPTEN__
    static const bool value =
        parse_query_value(url_get_current_search(), "host") == "gt";
    return value;
#else
    return false;
#endif
}
