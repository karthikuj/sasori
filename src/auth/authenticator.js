const {PuppeteerRunnerExtension, createRunner} = require('@puppeteer/replay');
const fs = require('fs');

/**
 * The Extension class responsible for running the pptr auth recording.
 */
class Extension extends PuppeteerRunnerExtension {
  /**
   * This defines what is to be executed before all other steps.
   * @param {@puppeteer/replay.UserFlow} flow
   */
  async beforeAllSteps(flow) {
    await super.beforeAllSteps(flow);
  }

  /**
   * This defines what is to be executed before each step.
   * @param {@puppeteer/replay.Step} step
   * @param {@puppeteer/replay.UserFlow} flow
   */
  async beforeEachStep(step, flow) {
    await super.beforeEachStep(step, flow);
  }

  /**
   * This defines what is to be executed after each step.
   * @param {@puppeteer/replay.Step} step
   * @param {@puppeteer/replay.UserFlow} flow
   */
  async afterEachStep(step, flow) {
    await super.afterEachStep(step, flow);
  }

  /**
   * This defines what is to be executed after all steps.
   * @param {@puppeteer/replay.UserFlow} flow
   */
  async afterAllSteps(flow) {
    await super.afterAllSteps(flow);
  }
}

/**
 * This runs the pptr recording in the context of the given browser and page.
 * @param {Puppeteer.Browser} browser
 * @param {Puppeteer.Page} page
 * @param {URL} pptrJsonRecordingPath
 */
async function authenticate(browser, page, pptrJsonRecordingPath) {
  const pptrJson = fs.readFileSync(pptrJsonRecordingPath,
      {encoding: 'utf8', flag: 'r'});
  const runner = await createRunner(
      JSON.parse(pptrJson),
      new Extension(browser, page, 30000),
  );

  await runner.run();
}

module.exports = authenticate;
