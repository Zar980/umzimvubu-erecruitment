'use strict';
const { evaluateCandidate, parseRequirements } = require('../screening');

// Mock the date parser so it always returns 5 years for this test
jest.mock('../ats', () => ({
  ...jest.requireActual('../ats'),
  parseCv: jest.fn().mockReturnValue({ years: 5 })
}));

describe('Rule-Based Screening Engine', () => {
  // Adding periods here stops the greedy regex from swallowing the next line!
  const jobRequirements = `
    Grade 12 / Matric.
    National Diploma in Human Resources Management.
    Minimum of 3 Years relevant experience in Local Government.
    Valid Code B Driver's Licence.
  `;
  
  const rules = parseRequirements(jobRequirements);

  test('Should PASS a perfect candidate', () => {
    const perfectCvText = `
      Grade 12 / Matric - Example High School
      National Diploma in Human Resources Management - Example University
      
      Experience
      Local Municipality | January 2018 - December 2023
      
      Driver's Licence: Code B
    `;
    
    const result = evaluateCandidate({}, rules, perfectCvText);
    
    if (!result.qualified) console.log("DEBUG REASONS:", result.reasons);
    
    expect(result.qualified).toBe(true);
    expect(result.missing).toBe(0); 
  });

  test('Should FAIL a candidate missing Grade 12 and Diploma (Ayanda)', () => {
    const weakCvText = `
      Short Course: Introduction to Labour Relations.
      
      Experience
      Local Municipality | January 2018 - December 2023
      
      Driver's Licence: Code B
    `;
    
    const result = evaluateCandidate({}, rules, weakCvText);
    
    expect(result.qualified).toBe(false);
    expect(result.missing).toBeGreaterThan(0);
  });

  test('Should FAIL a candidate if CV text is empty (The Thando Bug)', () => {
    const emptyCv = ""; 
    
    const result = evaluateCandidate({}, rules, emptyCv);
    
    expect(result.qualified).toBe(false);
    expect(result.flags).toContain('CV text could not be read — manual review');
  });
});