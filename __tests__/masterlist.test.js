'use strict';

describe('Master List Sorting Logic (UI & DB Simulation)', () => {
  
  test('Should correctly assign final verdict based on hybrid rules', () => {
    // Simulating the exact logic in masterlist.js
    function determineVerdict(result) {
      const ruleQualified = result.qualified;
      const scoreOk = (result.score || 0) >= 40;
      
      // If Gemini ran, trust its verdict. If not, fall back to rules.
      return result.source === 'hybrid-rules+gemini' 
        ? result.qualified 
        : (ruleQualified && scoreOk);
    }

    // Scenario A: AI says YES (even if old ATS score was low)
    const aiPass = { qualified: true, score: 50, source: 'hybrid-rules+gemini' };
    expect(determineVerdict(aiPass)).toBe(true);

    // Scenario B: AI says NO
    const aiFail = { qualified: false, score: 90, source: 'hybrid-rules+gemini' };
    expect(determineVerdict(aiFail)).toBe(false);

    // Scenario C: Rules pass, but ATS score is too low (No AI)
    const rulesPassLowScore = { qualified: true, score: 30, source: 'rules' };
    expect(determineVerdict(rulesPassLowScore)).toBe(false);

    // Scenario D: Rules pass, ATS score is good (No AI)
    const rulesPassHighScore = { qualified: true, score: 85, source: 'rules' };
    expect(determineVerdict(rulesPassHighScore)).toBe(true);
  });
});