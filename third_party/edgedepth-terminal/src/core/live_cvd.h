#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

// Bounded event-time series for a live cumulative volume delta strip.
// Input is already signed by aggressor side (buy positive, sell negative).
// It intentionally has no backfill API: an integrated flow panel starts from
// the real prints observed after it opens.
class LiveCvdSeries {
public:
    explicit LiveCvdSeries(std::size_t max_points = 3600)
        : max_points_(std::max<std::size_t>(1, max_points)) {}

    void add(std::int64_t timestamp_ms, double signed_notional) {
        if (timestamp_ms <= 0 || !std::isfinite(signed_notional)) return;

        const std::int64_t bucket_ms = (timestamp_ms / 1000) * 1000;
        const double bucket_s = static_cast<double>(bucket_ms) / 1000.0;
        cumulative_ += signed_notional;

        if (times_.empty()) {
            last_bucket_ms_ = bucket_ms;
            times_.push_back(bucket_s);
            values_.push_back(cumulative_);
            return;
        }

        // Ordered prints and repeated prints in the current second are the hot
        // path. Keep exactly one mutable point for that live bucket.
        if (bucket_ms == last_bucket_ms_) {
            values_.back() = cumulative_;
            return;
        }
        if (bucket_ms > last_bucket_ms_) {
            last_bucket_ms_ = bucket_ms;
            times_.push_back(bucket_s);
            values_.push_back(cumulative_);
            trim();
            return;
        }

        // Late prints stay in event-time order. CVD is cumulative, so the late
        // signed value changes its own bucket and every visible point after it.
        const auto at = std::lower_bound(times_.begin(), times_.end(), bucket_s);
        const std::size_t index = static_cast<std::size_t>(at - times_.begin());
        if (at == times_.begin() && bucket_s < times_.front()) {
            // The print predates the retained/live-from-open strip. Apply it to
            // every cumulative value without inventing an older start point.
            for (double& value : values_) value += signed_notional;
        } else if (at != times_.end() && *at == bucket_s) {
            for (std::size_t i = index; i < values_.size(); ++i) {
                values_[i] += signed_notional;
            }
        } else {
            const double inserted_value = values_[index - 1] + signed_notional;
            times_.insert(at, bucket_s);
            values_.insert(values_.begin() + static_cast<std::ptrdiff_t>(index),
                           inserted_value);
            for (std::size_t i = index + 1; i < values_.size(); ++i) {
                values_[i] += signed_notional;
            }
            trim();
        }
    }

    void clear() {
        times_.clear();
        values_.clear();
        cumulative_ = 0.0;
        last_bucket_ms_ = 0;
    }

    [[nodiscard]] bool empty() const { return times_.empty(); }
    [[nodiscard]] double cumulative() const { return cumulative_; }
    [[nodiscard]] const std::vector<double>& times() const { return times_; }
    [[nodiscard]] const std::vector<double>& values() const { return values_; }

private:
    void trim() {
        if (times_.size() <= max_points_) return;
        const std::size_t remove = times_.size() - max_points_;
        times_.erase(times_.begin(),
                     times_.begin() + static_cast<std::ptrdiff_t>(remove));
        values_.erase(values_.begin(),
                      values_.begin() + static_cast<std::ptrdiff_t>(remove));
    }

    std::size_t max_points_;
    std::vector<double> times_;
    std::vector<double> values_;
    double cumulative_ = 0.0;
    std::int64_t last_bucket_ms_ = 0;
};
