'use strict';

const OpenAI = require('openai');

// Initialize the Groq client using the OpenAI SDK
const groq = process.env.GROQ_API_KEY
  ? new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: 'https://api.groq.com/openai/v1', // Groq's OpenAI-compatible endpoint
    })
  : null;

/**
 * Dynamically evaluates a CV against whatever job requirements are passed in.
 */
async function evaluateWithGemini(cvText, jobRequirements, jobTitle) {
  if (!groq) {
    console.warn('[AI] No GROQ_API_KEY set — skipping AI evaluation.');
    return null;
  }

  const prompt = `
    You are an expert HR Recruiter and Applicant Tracking System (ATS) for a South African Local Municipality.
    Your task is to evaluate the candidate's CV against the specific Job Requirements provided below.

    JOB TITLE: ${jobTitle}
    
    JOB REQUIREMENTS:
    ${jobRequirements}

    CANDIDATE CV TEXT:
    ${String(cvText || '').slice(0, 15000)}

    Instructions for Evaluation:
    1. Read the JOB REQUIREMENTS carefully.
    2. Check the CV for explicit matches (exact keywords).
    3. Check the CV for implicit/contextual matches. (e.g., If the job asks for "Computer Literate", look for MS Office, email, administrative duties, or specific software. If the job asks for a specific qualification, check for synonyms or equivalent NQF levels).
    4. Evaluate Grade 12 / Matric, specific qualifications, years of experience, and driver's licenses exactly as stated in the requirements.
    5. Do NOT disqualify a candidate for minor phrasing mismatches if the equivalent skill or experience is clearly demonstrated in their work history.
    6. Be strict about mandatory requirements (e.g., if a specific diploma is required, they must have it or an explicitly accepted equivalent).

    You MUST return ONLY a JSON object in this exact format (no markdown, no extra text):
    {
      "qualified": true,
      "score": 85,
      "reasons": [
        "Meets the requirement for XYZ diploma",
        "Has 5 years of relevant experience (requires 3)",
        "Demonstrates computer literacy through admin roles"
      ],
      "missing_requirements": [
        "Does not have a valid driver's license"
      ]
    }
  `;

  try {
    const response = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b', 
      messages: [
        { role: 'system', content: 'You are a helpful ATS assistant that only outputs valid JSON.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' }, 
      temperature: 0.1,
    });

    const text = response.choices[0].message.content;
    return JSON.parse(text);
  } catch (err) {
    console.error('[AI] Groq API error:', err.message);
    return null;
  }
}

module.exports = { evaluateWithGemini };