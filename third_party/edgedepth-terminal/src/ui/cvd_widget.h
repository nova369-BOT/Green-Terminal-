#pragma once
// Live CVD companion panel for Green Terminal's flow-only EdgeDepth surface.
//
// This is intentionally not a candle chart or a synthetic history import. It
// accumulates the real aggressor-classified Trades stream from the moment the
// panel opens and says so while empty. Multiple client consumers share the one
// StreamManager subscription, so DOM/tape/CVD do not create extra sockets or
// duplicate server consumers.

#include "ui/widget.h"
#include "core/app_context.h"
#include "core/live_cvd.h"
#include "stream_handler.h"
#include "types/types.h"

#include <cstdint>
#include <string>

class CVDWidget : public Widget {
public:
    CVDWidget(const Terminal::Pair& pair, const AppContext& ctx);
    ~CVDWidget() override;

    void update() override {}
    void render() override;
    void on_rewind(int64_t cutoff_ms) override;

    WidgetType type() const override { return WidgetType::CVD; }
    UpdateFrequency update_frequency() const override { return UpdateFrequency::RealTime; }
    const char* title() const override { return title_.c_str(); }
    [[nodiscard]] const Terminal::Pair& pair() const { return pair_; }

private:
    void handle_trade(const Terminal::Trade& trade);

    Terminal::Pair pair_;
    const AppContext& ctx_;
    StreamKey stream_key_;
    std::string title_;

    // One point per UTC second, x in Unix seconds for ImPlot's Time scale.
    LiveCvdSeries series_; // default: bounded 3,600-point live strip
};
