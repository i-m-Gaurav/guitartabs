'use strict';

// Vercel serverless function: https://<your-site>/api/songs
// Set MONGODB_URII (and optionally APP_PASSWORD) in Vercel → Project → Settings → Environment Variables.
module.exports = require('../lib/songs-api').handler;
