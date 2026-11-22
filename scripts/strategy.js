// The portfolio rules, as a state machine over the S&P 500's daily closes.
//
//   Out:  3 closes in a row below the 200-day average  -> sell all the stocks.
//   Back: 3 closes in a row above it                    -> buy a third,
//         10 closes in a row above it                   -> a second third,
//         the 50-day average above the 200-day          -> the last third
//         (on a close above the line).
//   3 closes below at any point on the way back sells what was bought.
//
// Re-entry mirrors the exit: the old rule bought the first third on the first
// close above, so a single day's bounce could undo three days' patience, and it
// never said what to do if the market fell back mid-way.
//
// Only closes count. The page used to count the days it was *opened* while the
// live price was below the line — days it was not opened were never counted,
// and an intraday dip that closed above counted all the same.
//
// A classic script: index.html loads it as is, and the tests through vm.
(function (root) {
  function average(values, end, length) {
    if (end + 1 < length) return null;
    let sum = 0;
    for (let k = end - length + 1; k <= end; k++) sum += values[k];
    return sum / length;
  }

  // closes: official daily closes, oldest first; stamps: matching unix seconds.
  // Starts from fully invested; with a few years of history the start washes out.
  function strategyState(closes, stamps) {
    let held = 3;                 // thirds of the stock allocation held
    let below = 0, above = 0;     // consecutive closes on each side of the line
    const events = [];
    let last = -1;
    for (let i = 0; i < closes.length; i++) {
      const s200 = average(closes, i, 200);
      if (s200 == null) continue;
      const s50 = average(closes, i, 50);
      last = i;
      if (closes[i] < s200) { below++; above = 0; } else { above++; below = 0; }
      if (held > 0 && below >= 3) {
        held = 0;
        events.push({ i, date: stamps[i], type: 'exit' });
        continue;
      }
      // Several steps can land on the same day: after a short dip the 50-day
      // average may never have left the 200-day, so the tenth close above
      // brings the last third back with the second.
      if (held === 0 && above >= 3) { held = 1; events.push({ i, date: stamps[i], type: 'buy1' }); }
      if (held === 1 && above >= 10) { held = 2; events.push({ i, date: stamps[i], type: 'buy2' }); }
      if (held === 2 && above >= 1 && s50 > s200) { held = 3; events.push({ i, date: stamps[i], type: 'buy3' }); }
    }
    if (last < 0) return null;
    const sma200 = average(closes, last, 200), sma50 = average(closes, last, 50);
    const today = events.filter(e => e.i === last).map(e => e.type);
    return {
      held, below, above,
      index: last,                             // the close the state stands at
      close: closes[last], date: stamps[last],
      sma200, sma50,
      gapPct: (closes[last] / sma200 - 1) * 100,
      golden: sma50 > sma200,
      goldenGapPct: (sma50 / sma200 - 1) * 100,
      today,                                   // events on the last close: 'exit', 'buy1'…
      lastExit: events.filter(e => e.type === 'exit').pop() || null,
      events,
    };
  }

  root.strategyState = strategyState;
})(typeof window !== 'undefined' ? window : globalThis);
