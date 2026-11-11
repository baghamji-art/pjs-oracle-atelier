'use strict';
const { consultHandler } = require('./lib/consult-write.cjs');
exports.handler = consultHandler('admin');
