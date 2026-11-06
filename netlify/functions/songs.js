'use strict';

// Netlify Function. netlify.toml routes https://<your-site>/api/songs here.
// Set MONGODB_URI (and APP_PASSWORD) in Netlify → Site configuration → Environment variables,
// then trigger a new deploy.
const { netlifyHandler } = require('../../lib/songs-api');

exports.handler = netlifyHandler;
