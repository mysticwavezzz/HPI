import { Router } from 'express';
import { db } from '../db.js';
import { listPeople, summaryFor, getPerson, trendFor, listRaces, listRecalls } from '../queries.js';
import { httpError } from '../images.js';

export const publicRouter = Router();

// Active, non-candidate people with at least one poll, plus derived numbers.
publicRouter.get('/officials', (req, res) => {
  const officials = listPeople().filter((p) => p.category !== 'candidate')
    .map((p) => ({ ...p, summary: summaryFor(p) })).filter((p) => p.summary);
  const updated = db.prepare('SELECT MAX(survey_end) AS d FROM polls').get().d;
  res.json({ officials, updated });
});

publicRouter.get('/officials/:id/trend', (req, res) => {
  const person = getPerson(Number(req.params.id));
  if (!person || person.archived_at || person.category === 'candidate') throw httpError(404, 'Official not found.');
  const interval = req.query.interval === 'monthly' ? 'monthly' : 'weekly';
  res.json({ person, interval, points: trendFor(person.id, interval), summary: summaryFor(person) });
});

publicRouter.get('/forecast', (req, res) => {
  res.json({
    races: listRaces(),
    recalls: listRecalls('active'),
    referendums: listRecalls('archived'),
  });
});
