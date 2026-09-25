#pragma once
// ═══════════════════════════════════════════════════════════════════════════════
// theme.h - edgedepth design system: tokens + ImGui/ImPlot style + fonts
//
// Source of truth: the edgedepth design system - tokens.json (v0.1.0) and
// edgedepth.css (:root block). Dark-only.
// Near-black cool charcoal surfaces, teal-up / magenta-rose-down market data,
// cyan brand accent (used sparingly), amber for replay/events/POC.
//
// Semantic colors (UP/DOWN/BRAND/…) are runtime-mutable so the Tweaks panel
// can switch candle conventions and accents without a rebuild. Surfaces,
// borders and text ramp are fixed constexpr.
//
// Legacy aliases (Theme::Colors::BUY_GREEN etc.) are kept so existing widgets
// compile unchanged; new/reworked code should use Theme::Tokens:: directly.
// ═══════════════════════════════════════════════════════════════════════════════
#include <cstdint>

#include "imgui.h"

namespace Theme {

    // hex 0xRRGGBB → ImVec4
    constexpr ImVec4 from_hex(uint32_t rgb, float a = 1.0f) {
        return ImVec4(((rgb >> 16) & 0xFF) / 255.0f,
                      ((rgb >> 8) & 0xFF) / 255.0f,
                      (rgb & 0xFF) / 255.0f, a);
    }

    // ImVec4 → ImU32 with optional alpha multiplier
    inline ImU32 u32(const ImVec4& c, float alpha_mul = 1.0f) {
        return IM_COL32(static_cast<int>(c.x * 255.0f),
                        static_cast<int>(c.y * 255.0f),
                        static_cast<int>(c.z * 255.0f),
                        static_cast<int>(c.w * alpha_mul * 255.0f));
    }

    // ── Runtime tweak enums (wired to the Tweaks panel in a later phase) ─────
    enum class Accent : uint8_t { Teal, Indigo, Amber, Mono };
    enum class CandleConvention : uint8_t { TealMag, Classic, Muted, BlueWhite, Custom };

    namespace Tokens {
        // ── Surfaces - Green Terminal racing-green ramp ───────────────────────
        // bg-0 app background / chart canvas · bg-1 bars + panel chrome ·
        // Black-green planes; controls have no idle tile. Hover and focus
        // reveal the hit area, while a rule and text identify selection.
        inline constexpr ImVec4 BASE   = from_hex(0x05080a);  // bg-0 black-green
        inline constexpr ImVec4 PANEL  = from_hex(0x0a0f0c);  // bg-1
        inline constexpr ImVec4 ELEV   = from_hex(0x0e1511);  // bg-2
        inline constexpr ImVec4 INPUT  = from_hex(0x0b100d);  // editable fields
        inline constexpr ImVec4 HOVER  = from_hex(0x14201a);  // bg-2
        inline constexpr ImVec4 ACTIVE = from_hex(0x1b2b22);  // bg-2 (accent marks "on")

        // ── Hairlines - line-1 borders/dividers, line-2 control borders ──────
        inline constexpr ImVec4 BD1  = from_hex(0x1c2620);          // line-1 - the only separation
        inline constexpr ImVec4 BD2  = from_hex(0x2c3b32);          // line-2 - control borders
        inline constexpr ImVec4 BD3  = from_hex(0x7d8a80, 0.55f);   // hover borders (text-3 hue)
        inline constexpr ImVec4 GRID = from_hex(0x1c2620, 0.55f);   // chart gridlines (line-1)

        // ── Text ramp - text-1/2/3 (+ dimmed text-3 for axis/disabled) ───────
        inline constexpr ImVec4 TX1 = from_hex(0xf4f1e8);  // primary numerals, titles (ivory)
        inline constexpr ImVec4 TX2 = from_hex(0xb9c0b4);  // labels, secondary data
        inline constexpr ImVec4 TX3 = from_hex(0x7d8a80);  // captions, units, group labels
        inline constexpr ImVec4 TX4 = from_hex(0x6b766e, 0.72f);  // axis ticks, disabled

        // ── Semantic - runtime-mutable (candle convention / accent tweaks) ──
        inline ImVec4 UP         = from_hex(0x1f9d55);         // up / bid / positive (racing green)
        inline ImVec4 DOWN       = from_hex(0xa83246);         // down / ask / negative (oxblood)
        inline ImVec4 UP_SOFT    = from_hex(0x1f9d55, 0.13f);
        inline ImVec4 DOWN_SOFT  = from_hex(0xa83246, 0.13f);
        inline ImVec4 UP_LINE    = from_hex(0x1f9d55, 0.50f);
        inline ImVec4 DOWN_LINE  = from_hex(0xa83246, 0.50f);
        inline ImVec4 BRAND      = from_hex(0xb08d57);         // accent - brushed brass, the only on-state hue
        inline ImVec4 BRAND_SOFT = from_hex(0xb08d57, 0.14f);
        inline ImVec4 BRAND_LINE = from_hex(0xb08d57, 0.55f);
        inline ImVec4 BRAND_TX   = from_hex(0xf4f1e8);         // accent textTint (on-state text)
        inline constexpr ImVec4 WARN = from_hex(0xd9a441);     // funding, big prints, alerts (brass amber)
        inline constexpr ImVec4 WARN_SOFT = from_hex(0xd9a441, 0.12f);  // replay banner, high-regime chip fill
        // dark ink for text on solid BRAND fills (play orb, price chip, pills)
        inline constexpr ImVec4 BRAND_INK = from_hex(0x11150f);
        // Brand identity, FIXED: the Green Terminal mark and the G-FLOW lockup
        // keep brushed brass whatever accent the chrome runs, so the terminal
        // header matches the product brand.
        // Identity only - never an on-state hue (that stays BRAND*).
        inline constexpr ImVec4 LOGO    = from_hex(0xb08d57);
        inline constexpr ImVec4 LOGO_TX = from_hex(0xd9c08a);
        // resting-book sage (DOM v2): pending limit-order depth, side-agnostic. The
        // one neutral data hue - green/red stays reserved for EXECUTED flow.
        inline constexpr ImVec4 REST      = from_hex(0x6b8f71);
        inline constexpr ImVec4 REST_SOFT = from_hex(0x6b8f71, 0.30f);

        // ── Heatmap ramps (fixed LUT stops; full LUTs built in heatmap code) ─
        // viridis - liquidation field legend / colormap stops
        inline constexpr ImVec4 VIRIDIS[6] = {
            from_hex(0x440154), from_hex(0x414487), from_hex(0x2a788e),
            from_hex(0x22a884), from_hex(0x7ad151), from_hex(0xfde725)};
        // grove - DOM depth cells (small=deep green → large=brass/gold)
        inline constexpr ImVec4 OCEAN[6] = {
            from_hex(0x07100a), from_hex(0x0e3a24), from_hex(0x1f6a44),
            from_hex(0x3f9d5c), from_hex(0xa8c686), from_hex(0xe8d48a)};
        // iceberg marker accent (DOM row tick)
        inline constexpr ImVec4 ICEBERG_VIOLET = from_hex(0xb07cff);
    }

    // ── Radii ────────────────────────────────────────────────────────────────
    // Chrome rules: docked panels are SQUARE with 1px line-1 borders only -
    // Floating menus, inputs and badges also use square corners.
    namespace Radius {
        inline constexpr float R1 = 0.0f;   // small chips / table chips
        inline constexpr float R2 = 0.0f;   // buttons, inputs, frames
        inline constexpr float R3 = 0.0f;   // floating panels / popups / menus
    }

    // ── Layout metrics (px, logical) - theme-tokens.json `density` ──────────
    namespace Layout {
        inline constexpr float TOPBAR_H        = 44.0f;
        inline float topbar_h() { return ImGui::GetIO().DisplaySize.x < 1150 ? 82.0f : TOPBAR_H; }
        inline constexpr float STATSBAR_H      = 36.0f;   // compact market header; closeable
        inline constexpr float PILLSROW_H      = 44.0f;   // v2 chart toolbar band (was 36)
        inline constexpr float STATUSBAR_H     = 30.0f;   // owns telemetry (WS · FPS · CLOCK)
        inline constexpr float TRANSPORT_H     = 66.0f;
        // The watchlist stacks price below the symbol on compact rails.
        // Reserve the order-book width from the remaining center/right space.
        inline constexpr float WATCHLIST_W     = 288.0f;
        inline constexpr float RIGHTCOL_W      = 440.0f;
        inline constexpr float INDI_PANE_H     = 172.0f;
        inline constexpr float PANEL_HEADER_H  = 26.0f;
        inline constexpr float WATCHLIST_ROW_H = 24.0f;   // default-density watchlist row
        inline constexpr float DOMTAPE_ROW_H   = 18.0f;   // default-density DOM/tape row
        inline constexpr float PANEL_PAD       = 8.0f;
        inline constexpr float PRICE_GUTTER_R  = 66.0f;
        inline constexpr float TIME_AXIS_B     = 22.0f;
    }

    // ── Density (Tweaks-driven; 3-10, default 8) ─────────────────────────────
    int  density();
    void set_density(int d);                 // clamps to [3,10], re-derives row heights
    float row_h();                           // watchlist rows - d8 = WATCHLIST_ROW_H (24)
    float row_h_dense();                     // DOM/tape rows - d8 = DOMTAPE_ROW_H (18)

    // ── Runtime tweaks ───────────────────────────────────────────────────────
    Accent accent();
    CandleConvention candles();
    void load_preferences();
    void render_appearance_controls();
    void set_accent(Accent a);                       // mutates BRAND* tokens
    void set_candle_convention(CandleConvention c);  // mutates UP*/DOWN* tokens

    // ── Fonts ────────────────────────────────────────────────────────────────
    // Inter = chrome/labels/headings. Roboto Mono = ALL numerics
    // (naturally fixed-advance → tabular alignment for free).
    namespace Fonts {
        ImFont* ui();           // Inter Regular 13 - default chrome text
        ImFont* ui_semibold();  // Inter SemiBold 13 - emphasis, symbol names
        ImFont* heading();      // Inter SemiBold 17 - panel/modal headings
        ImFont* label();        // Inter SemiBold 9.5 - uppercase micro-labels
        ImFont* mono_xs();      // Roboto Mono SemiBold ~9.5 - EARLY ACCESS pill / micro badges
        ImFont* mono_sm();      // Roboto Mono Regular 10.5 - dense ladders/tape
        ImFont* mono();         // Roboto Mono Regular 12 - default numerics
        ImFont* mono_md();      // Roboto Mono Medium 14 - mark price, replay clock
        ImFont* mono_lg();      // Roboto Mono SemiBold 20 - large displays
    }

    // ── Style application ────────────────────────────────────────────────────
    void apply_dark_theme();      // full ImGui + ImPlot mapping from tokens
    void apply_trading_colors();  // table borders/headers (hairline style)
    bool load_fonts();            // builds the 8-face atlas (DPI-aware)

    // Shared transient surfaces and selection controls. Popup padding is latched
    // by BeginPopup, so callers keep the normal ImGui::EndPopup pairing.
    bool begin_popup(const char* id, ImGuiWindowFlags flags = 0);
    bool choice_button(const char* label, bool selected, ImVec2 size = ImVec2(0, 0));
    void section_label(const char* label);

    // ── Tooltips ─────────────────────────────────────────────────────────────
    // The global WindowPadding is (0,0) (panels manage their own gutters) and
    // ImGui tooltip windows inherit it, so raw ImGui::SetTooltip/BeginTooltip
    // renders text flush against the border (looks clipped). All tooltips
    // route through these, which push floating-chrome padding + radius first.
    void begin_tooltip();
    void end_tooltip();
    void tooltip(const char* fmt, ...) IM_FMTARGS(1);  // SetTooltip replacement

    // ── Legacy compatibility layer - migrate widgets off these per-phase ─────
    namespace Colors {
        inline const ImVec4& BUY_GREEN       = Tokens::UP;
        inline const ImVec4& SELL_RED        = Tokens::DOWN;
        inline const ImVec4& BUY_GREEN_DIM   = Tokens::UP_LINE;
        inline const ImVec4& SELL_RED_DIM    = Tokens::DOWN_LINE;
        inline constexpr ImVec4 PRICE_YELLOW = Tokens::WARN;
        inline constexpr ImVec4 NEUTRAL_GRAY = Tokens::TX3;
        inline constexpr ImVec4 BACKGROUND_DARK = Tokens::BASE;
        inline constexpr ImVec4 PANEL_BG     = Tokens::PANEL;
        inline constexpr ImVec4 BORDER       = Tokens::BD2;
        inline constexpr ImVec4 TEXT_PRIMARY = Tokens::TX1;
        inline constexpr ImVec4 TEXT_SECONDARY = Tokens::TX2;
    }

    namespace FontSizes {  // legacy names, new scale
        inline constexpr float SMALL  = 13.0f;
        inline constexpr float NORMAL = 16.0f;
        inline constexpr float LARGE  = 20.0f;
        inline constexpr float XLARGE = 23.0f;
    }
    namespace Spacing {  // legacy names, new metrics
        inline constexpr float PADDING         = 8.0f;
        inline constexpr float ITEM_SPACING    = 6.0f;
        inline constexpr float WINDOW_ROUNDING = 0.0f;  // panels are square
        inline constexpr float FRAME_ROUNDING  = Radius::R2;
    }

    // legacy font accessors → new atlas
    ImFont* get_regular_font();  // = Fonts::ui()
    ImFont* get_bold_font();     // = Fonts::ui_semibold()
    ImFont* get_large_font();    // = Fonts::mono_md()

    // legacy semantic helpers (read mutable tokens → tweak-aware)
    ImVec4 get_buy_color(float alpha = 1.0f);
    ImVec4 get_sell_color(float alpha = 1.0f);
    ImU32 get_buy_color_u32(uint8_t alpha = 255);
    ImU32 get_sell_color_u32(uint8_t alpha = 255);
}
