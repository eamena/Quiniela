function getOutcome(home, away) {
  if (home > away) return "home";
  if (home < away) return "away";
  return "draw";
}

function scorePrediction(predHome, predAway, realHome, realAway) {
  const exact = predHome === realHome && predAway === realAway;
  if (exact) {
    return { points: 5, exact: 1, outcome: 1 };
  }

  const outcomeMatch = getOutcome(predHome, predAway) === getOutcome(realHome, realAway);
  return { points: outcomeMatch ? 2 : 0, exact: 0, outcome: outcomeMatch ? 1 : 0 };
}

module.exports = { scorePrediction };
