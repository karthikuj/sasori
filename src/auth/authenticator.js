import { createRunner, PuppeteerRunnerExtension } from '@puppeteer/replay';
import fs from 'fs';

class Extension extends PuppeteerRunnerExtension {
    async beforeAllSteps(flow) {
        await super.beforeAllSteps(flow);
        // console.log('starting');
    }

    async beforeEachStep(step, flow) {
        await super.beforeEachStep(step, flow);
        // console.log('before', step);
    }

    async afterEachStep(step, flow) {
        await super.afterEachStep(step, flow);
        // console.log('after', step);
    }

    async afterAllSteps(flow) {
        await super.afterAllSteps(flow);
        // console.log('done');
    }
}

async function authenticate(browser, page, jsonRecording) {
    const data = fs.readFileSync(jsonRecording,
        { encoding: 'utf8', flag: 'r' });
    const runner = await createRunner(
        JSON.parse(data),
        new Extension(browser, page, 7000)
    );

    await runner.run();
}

export default authenticate;