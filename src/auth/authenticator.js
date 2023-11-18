import { createRunner, PuppeteerRunnerExtension } from '@puppeteer/replay';
import fs from 'fs';

class Extension extends PuppeteerRunnerExtension {
    async beforeAllSteps(flow) {
        await super.beforeAllSteps(flow);
    }

    async beforeEachStep(step, flow) {
        await super.beforeEachStep(step, flow);
    }

    async afterEachStep(step, flow) {
        await super.afterEachStep(step, flow);
    }

    async afterAllSteps(flow) {
        await super.afterAllSteps(flow);
    }
}

async function authenticate(browser, page, pptrJsonRecordingPath) {
    const pptrJson = fs.readFileSync(pptrJsonRecordingPath,
        { encoding: 'utf8', flag: 'r' });
    const runner = await createRunner(
        JSON.parse(pptrJson),
        new Extension(browser, page, 30000)
    );

    await runner.run();
}

export default authenticate;