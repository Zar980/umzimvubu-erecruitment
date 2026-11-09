'use strict';

// Set the API key BEFORE requiring the module so it initializes the client
process.env.GROQ_API_KEY = 'gsk_dummy_key_for_testing';

// Mock the OpenAI library (which Groq uses)
jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  qualified: true,
                  score: 90,
                  reasons: ["Meets all requirements", "Has the right diploma"],
                  missing_requirements: []
                })
              }
            }
          ]
        })
      }
    }
  }));
});

const { evaluateWithGemini } = require('../ai-screener');

describe('Groq AI Screener Integration', () => {
  test('Should successfully parse a valid AI JSON response', async () => {
    const result = await evaluateWithGemini("CV Text", "Req Text", "Job Title");
    
    expect(result).toBeDefined();
    expect(result.qualified).toBe(true);
    expect(result.score).toBe(90);
    expect(result.reasons[0]).toBe("Meets all requirements");
  });
});