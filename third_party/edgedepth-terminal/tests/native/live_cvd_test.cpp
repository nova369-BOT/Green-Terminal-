#include "core/live_cvd.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>

namespace {
void check(bool condition, const char* message) {
    if (condition) return;
    std::fprintf(stderr, "FAIL: %s\n", message);
    std::exit(1);
}

bool near(double a, double b) {
    return std::abs(a - b) < 1e-9;
}
} // namespace

int main() {
    LiveCvdSeries cvd(3);
    check(cvd.empty(), "a new live strip is empty rather than fabricated");

    cvd.add(1'100, 100.0);
    cvd.add(1'900, -25.0);
    check(cvd.times().size() == 1, "same-second prints share one point");
    check(near(cvd.values().back(), 75.0), "the live bucket updates in place");

    cvd.add(3'100, 50.0);
    cvd.add(2'100, 20.0); // arrives late, belongs between the visible points
    check(cvd.times().size() == 3, "a late bucket is inserted once");
    check(near(cvd.times()[0], 1.0) && near(cvd.times()[1], 2.0) &&
          near(cvd.times()[2], 3.0), "late buckets remain in event-time order");
    check(near(cvd.values()[0], 75.0) && near(cvd.values()[1], 95.0) &&
          near(cvd.values()[2], 145.0), "late volume shifts every later cumulative point");

    cvd.add(1'500, -5.0); // exact older bucket
    check(near(cvd.values()[0], 70.0) && near(cvd.values()[2], 140.0),
          "late volume in an existing bucket shifts that bucket onward");

    cvd.add(500, 10.0); // predates the live-from-open strip
    check(cvd.times().size() == 3 && near(cvd.times().front(), 1.0),
          "a pre-open timestamp does not fabricate an older start point");
    check(near(cvd.values().front(), 80.0) && near(cvd.cumulative(), 150.0),
          "a pre-open late print still changes the truthful cumulative values");

    cvd.add(4'100, -30.0);
    check(cvd.times().size() == 3 && near(cvd.times().front(), 2.0),
          "the configured bound trims the oldest point");
    check(near(cvd.values().back(), 120.0) && near(cvd.cumulative(), 120.0),
          "the latest plotted value equals the cumulative total");

    cvd.add(5'100, std::numeric_limits<double>::infinity());
    cvd.add(0, 999.0);
    check(cvd.times().size() == 3 && near(cvd.cumulative(), 120.0),
          "invalid input cannot poison the live strip");

    cvd.clear();
    check(cvd.empty() && near(cvd.cumulative(), 0.0),
          "rewind clear removes all potentially future volume");

    std::puts("live_cvd_test: all assertions passed");
    return 0;
}
