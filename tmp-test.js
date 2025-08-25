import express from 'express';
import users from './users.js';
const app = express();
users.registerUserRoutes(app, { readJson: () => [], USERS_FILE: '' });
const routes = (app._router?.stack || [])
  .filter(l => l.route)
  .map(l => `${Object.keys(l.route.methods).join(',').toUpperCase()} ${l.route.path}`);
console.log('routes', routes);
