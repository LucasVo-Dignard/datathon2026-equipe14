'use strict';
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { validate, buildProfile, profileSummary, publicQuestionnaire, ProfileError, PERSONAS } = require('../app/profile');

const persona = (id) => PERSONAS.find((p) => p.id === id).answers;
const profileOf = (answers) => buildProfile(validate(answers));
const titles = (p) => p.tensions.map((t) => t.title);

test('each persona gets the risk level given in the case brief', () => {
  for (const p of PERSONAS) {
    const r = profileOf(p.answers);
    assert.equal(r.level.label, p.risk, p.name);
    assert.equal(r.closestPersona.id, p.id, `${p.name} should be closest to itself`);
  }
});

test('Amira: high risk still keeps diversification and caps crypto', () => {
  const r = profileOf(persona('amira'));
  assert.equal(r.guardrails.maxCryptoShare, 10);
  assert.ok(r.guardrails.minDiversifiedAssets >= 5);
  assert.ok(r.guardrails.maxSingleSectorShare < 50);
});

test('Mateo: ESG exclusions are passed to the agents', () => {
  const r = profileOf(persona('mateo'));
  assert.deepEqual(r.guardrails.excludedActivities, ['fossil', 'weapons', 'controversies']);
  assert.equal(r.guardrails.maxCryptoShare, 0);
});

test('Robert: attraction to hyped stocks is flagged against his profile', () => {
  const r = profileOf(persona('robert'));
  assert.ok(titles(r).includes('Attention aux titres très médiatisés'));
  assert.match(profileSummary(r), /Tension : Attention aux titres très médiatisés/);
});

test('risk tolerance cannot exceed capacity', () => {
  // Very bold answers, but money needed in < 3 years and 75 %+ of savings.
  const r = profileOf({ ...persona('amira'), horizon: 'lt3', savingsShare: 'gt75', age: '60p' });
  assert.ok(r.score <= r.capacity.score);
  assert.ok(r.tolerance.score - r.capacity.score >= 20);
  assert.ok(titles(r).includes('Votre tolérance dépasse votre capacité à prendre du risque'));
  assert.ok(titles(r).includes('Horizon court pour un objectif de croissance'));
});

test('objective caps the level', () => {
  const r = profileOf({ ...persona('amira'), objective: 'purchase' });
  assert.equal(r.score, 20);
  assert.ok(titles(r).includes('Niveau plafonné par votre objectif'));
});

test('crypto interest on a cautious profile is a warning and gets 0 %', () => {
  const r = profileOf({ ...persona('robert'), crypto: 'strong' });
  assert.equal(r.guardrails.maxCryptoShare, 0);
  assert.ok(titles(r).includes('Intérêt pour les cryptoactifs incompatible avec votre niveau de risque'));
});

test('validation rejects missing, unknown and out-of-range answers', () => {
  assert.throws(() => validate({}), ProfileError);
  assert.throws(() => validate({ ...persona('mateo'), horizon: 'forever' }), ProfileError);
  assert.throws(() => validate({ ...persona('mateo'), sectors: ['tech', 'casino'] }), ProfileError);
  assert.throws(() => validate({ ...persona('mateo'), capital: -5 }), ProfileError);
  assert.throws(() => validate(null), ProfileError);
});

test('optional answers can be skipped', () => {
  const { capital, sectors, exclusions, ...required } = persona('mateo');
  const a = validate(required);
  assert.deepEqual(a.sectors, []);
  assert.equal(a.capital, undefined);
  assert.equal(buildProfile(a).capital, null);
});

test('public questionnaire exposes every question with options', () => {
  const { questions, personas } = publicQuestionnaire();
  assert.equal(personas.length, 3);
  for (const q of questions) {
    assert.ok(q.text && q.section);
    if (q.type !== 'number') assert.ok(q.options.length >= 2, q.id);
  }
});
