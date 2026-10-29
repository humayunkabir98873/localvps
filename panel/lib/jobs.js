import crypto from 'node:crypto';

// Long-running work (downloads, exports, deploys) runs as a job whose log the UI polls.
const jobs = new Map();
// Lets the HTTP layer tell "a job was started" apart from "here is a job's status".
const started = new WeakSet();
export const isStartedJob = (o) => started.has(o);

export function startJob(type, title, fn) {
  const job = {
    id: crypto.randomBytes(6).toString('hex'),
    type, title,
    status: 'running',
    progress: null,
    log: [],
    result: null,
    error: null,
    started: Date.now(),
    ended: null,
  };
  jobs.set(job.id, job);
  started.add(job);
  const ctx = {
    log: (msg) => {
      // Tools like npm and composer emit ANSI colors and \r progress redraws; keep plain text.
      const clean = String(msg).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      for (const line of clean.split(/\r?\n|\r/)) {
        if (line.trim() !== '') job.log.push(line);
      }
      if (job.log.length > 5000) job.log.splice(0, job.log.length - 5000);
    },
    progress: (p) => { job.progress = p; },
  };
  Promise.resolve()
    .then(() => fn(ctx))
    .then((result) => { job.result = result ?? null; job.status = 'done'; ctx.log('✔ Done'); })
    .catch((err) => { job.error = err.message; job.status = 'failed'; ctx.log(`✖ ${err.message}`); })
    .finally(() => { job.ended = Date.now(); job.progress = null; });
  pruneOld();
  return job;
}

function pruneOld() {
  const done = [...jobs.values()].filter((j) => j.status !== 'running').sort((a, b) => a.ended - b.ended);
  while (done.length > 30) jobs.delete(done.shift().id);
}

export function getJob(id, since = 0) {
  const j = jobs.get(id);
  if (!j) return null;
  return { ...j, log: j.log.slice(since), logOffset: since, logLength: j.log.length };
}

export function listJobs() {
  return [...jobs.values()]
    .sort((a, b) => b.started - a.started)
    .map(({ log, ...rest }) => ({ ...rest, lastLine: log[log.length - 1] || '' }));
}

export function hasRunning(type) {
  return [...jobs.values()].some((j) => j.status === 'running' && j.type === type);
}
