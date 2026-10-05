#include "ui/cvd_widget.h"

#include "core/stream_presence.h"
#include "implot.h"
#include "rendering/theme.h"

#include <algorithm>
#include <cstddef>
#include <cmath>
#include <cstdio>

namespace {
void compact_value(double value, char* out, size_t size) {
    const double a = std::abs(value);
    if (a >= 1e9)      std::snprintf(out, size, "%+.2fB", value / 1e9);
    else if (a >= 1e6) std::snprintf(out, size, "%+.2fM", value / 1e6);
    else if (a >= 1e3) std::snprintf(out, size, "%+.1fK", value / 1e3);
    else               std::snprintf(out, size, "%+.0f", value);
}
} // namespace

CVDWidget::CVDWidget(const Terminal::Pair& pair, const AppContext& ctx)
    : pair_(pair)
    , ctx_(ctx)
    , stream_key_{pair, Terminal::Stream::Trades, 0}
    , title_(std::string("     Live CVD  ") + widget_symbol_label(pair.symbol) +
             "###cvd_" + pair.exchange + "_" + pair.symbol) {
    StreamHandler<Terminal::Trade> handler{
        .widget_ptr = this,
        .callback = [](void* ptr, const Terminal::Trade& trade) {
            static_cast<CVDWidget*>(ptr)->handle_trade(trade);
        }
    };
    subscribed_streams_ = &ctx_.stream_mgr();
    subscribed_streams_->subscribe_trades(stream_key_, handler);
}

CVDWidget::~CVDWidget() {
    if (subscribed_streams_) subscribed_streams_->unsubscribe_trades(stream_key_, this);
}

void CVDWidget::handle_trade(const Terminal::Trade& trade) {
    if (!(trade.price > 0.0) || !(trade.qty > 0.0) || trade.timestamp_ms <= 0 ||
        !std::isfinite(trade.price) || !std::isfinite(trade.qty)) return;

    const double notional = trade.price * trade.qty;
    if (!std::isfinite(notional)) return;
    series_.add(trade.timestamp_ms, trade.is_buy ? notional : -notional);
}

void CVDWidget::on_rewind(int64_t /*cutoff_ms*/) {
    // A one-second point may contain prints on both sides of an arbitrary
    // rewind cutoff. Clear rather than retain any possible future volume;
    // replay delivery can then rebuild the strip from real prints.
    series_.clear();
}

void CVDWidget::render() {
    if (!is_open) return;
    place_new_window();
    if (!ImGui::Begin(title_.c_str(), &is_open,
                      ImGuiWindowFlags_NoCollapse | ImGuiWindowFlags_NoScrollbar)) {
        ImGui::End();
        return;
    }

    if (series_.empty()) {
        const bool absent =
            StreamPresence::instance().absent(static_cast<uint32_t>(Terminal::Stream::Trades));
        ImGui::PushFont(Theme::Fonts::label());
        ImGui::PushStyleColor(ImGuiCol_Text, Theme::Tokens::TX3);
        ImGui::PushTextWrapPos(ImGui::GetCursorPosX() + ImGui::GetContentRegionAvail().x - 8.0f);
        ImGui::TextUnformatted(absent
            ? "No trades received. Live CVD is waiting on the real trade stream; nothing is simulated."
            : "Collecting real trades. Live CVD starts at panel open; no history is fabricated.");
        ImGui::PopTextWrapPos();
        ImGui::PopStyleColor();
        ImGui::PopFont();
        ImGui::End();
        return;
    }

    const double cumulative = series_.cumulative();
    char latest[32];
    compact_value(cumulative, latest, sizeof(latest));
    ImGui::PushFont(Theme::Fonts::mono_sm());
    ImGui::TextColored(cumulative >= 0.0 ? Theme::Tokens::UP : Theme::Tokens::DOWN,
                       "CVD (USD)  %s", latest);
    ImGui::SameLine();
    ImGui::TextColored(Theme::Tokens::TX4, "live from open");
    ImGui::PopFont();

    const auto& times = series_.times();
    const auto& values = series_.values();
    const ImPlotFlags plot_flags = ImPlotFlags_NoLegend | ImPlotFlags_NoMenus |
                                    ImPlotFlags_NoBoxSelect | ImPlotFlags_NoTitle;
    if (ImPlot::BeginPlot("##live_cvd_plot", ImVec2(-1, -1), plot_flags)) {
        ImPlot::SetupAxis(ImAxis_X1, nullptr,
                          ImPlotAxisFlags_AutoFit | ImPlotAxisFlags_NoLabel);
        ImPlot::SetupAxisScale(ImAxis_X1, ImPlotScale_Time);
        ImPlot::SetupAxis(ImAxis_Y1, nullptr,
                          ImPlotAxisFlags_AutoFit | ImPlotAxisFlags_NoLabel);
        ImPlot::PushStyleColor(ImPlotCol_Line, Theme::Tokens::BRAND);
        ImPlot::PushStyleColor(ImPlotCol_Fill, ImVec4(
            Theme::Tokens::BRAND.x, Theme::Tokens::BRAND.y,
            Theme::Tokens::BRAND.z, 0.16f));
        ImPlot::PlotShaded("##cvd_fill", times.data(), values.data(),
                           static_cast<int>(times.size()), 0.0);
        ImPlot::PlotLine("##cvd_line", times.data(), values.data(),
                         static_cast<int>(times.size()));
        ImPlot::PopStyleColor(2);
        ImPlot::EndPlot();
    }
    ImGui::End();
}
