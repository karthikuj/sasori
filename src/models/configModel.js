const Joi = require('joi');

/**
 * Proxy model for the proxy configuration of the crawler
 */
const proxyModel = Joi.object({
  enabled: Joi.boolean().required(),
  host: Joi.string().hostname().when('enabled', {
    is: true,
    then: Joi.string().hostname().required(),
    otherwise: Joi.string().hostname(),
  }),
  port: Joi.number().integer().when('enabled', {
    is: true,
    then: Joi.number().integer().required(),
    otherwise: Joi.number().integer(),
  }),
}).required();

/**
 * Basic auth model for HTTP basic authentication.
 */
const basicAuthModel = Joi.object({
  enabled: Joi.boolean().required(),
  username: Joi.string().when('enabled', {
    is: true,
    then: Joi.string().required(),
    otherwise: Joi.string(),
  }),
  password: Joi.string().when('enabled', {
    is: true,
    then: Joi.string().required(),
    otherwise: Joi.string(),
  }),
}).required();

/**
 * Script auth model for pptr script based auth configurations.
 */
const scriptAuthModel = Joi.object({
  enabled: Joi.boolean().required(),
  pptrRecording: Joi.string().when('enabled', {
    is: true,
    then: Joi.string().required(),
    otherwise: Joi.string(),
  }),
}).required();

/**
 * Authentication model for all the authentication configurations.
 */
const authenticationModel = Joi.object({
  basicAuth: basicAuthModel,
  scriptAuth: scriptAuthModel,
});

/**
 * Browser model for the browser configuration of the crawler.
 */
const browserModel = Joi.object({
  headless: Joi.boolean(),
  maximize: Joi.boolean(),
  proxy: proxyModel,
});

/**
 * Crawler model for the main crawler configurations.
 */
const crawlerModel = Joi.object({
  entryPoint: Joi.string().uri().required(),
  eventTimeout: Joi.number().integer().required(),
  navigationTimeout: Joi.number().integer().required(),
  eventWait: Joi.number().integer().required(),
  maxDuration: Joi.number().integer().required(),
  elements: Joi.array().items(Joi.string()).min(1).required(),
  maxChildren: Joi.number().integer().required(),
  maxDepth: Joi.number().integer().required(),
  authentication: authenticationModel,
  includeRegexes: Joi.array().items(Joi.string()).min(1).required(),
  excludeRegexes: Joi.array().items(Joi.string()).required(),
}).required();

/**
 * The entire crawler config.
 */
const configModel = Joi.object({
  browser: browserModel,
  crawler: crawlerModel,
});

module.exports = configModel;
