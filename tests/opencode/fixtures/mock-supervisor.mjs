#!/usr/bin/env node
const jobId = process.argv[2] ?? "job_unknown";
process.title = `buddy-supervisor:${jobId}`;
setInterval(() => {}, 1000);
