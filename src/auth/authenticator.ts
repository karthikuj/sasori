import { PuppeteerRunnerExtension, createRunner, Step, UserFlow } from '@puppeteer/replay';
import { Browser, Page } from 'puppeteer';
import * as fs from 'fs';

/**
 * Parameters for executeScript step
 */
interface ExecuteScriptParameters {
    target: string;
}

/**
 * Type guard to check if step has parameters
 */
function hasParameters(step: Step): step is Step & { parameters: ExecuteScriptParameters } {
    return 'parameters' in step && step.parameters !== null && typeof step.parameters === 'object';
}

/**
 * Custom step handler interface
 */
interface CustomStepHandler {
    executeScript: (step: Step, page: Page) => Promise<void>;
}

/**
 * The Extension class responsible for running the pptr auth recording.
 */
class Extension extends PuppeteerRunnerExtension {
    /**
     * Handler for executeScript custom steps
     * @param step - The step to execute
     * @param page - The Puppeteer page instance
     */
    static executeScriptHandler = async (step: Step, page: Page): Promise<void> => {
        if (hasParameters(step)) {
            const parameters = step.parameters;
            if (Object.hasOwnProperty.call(parameters, 'target')) {
                await page.evaluate(parameters['target']);
            }
        }
    };

    static customStepHandler: CustomStepHandler = {
        executeScript: this.executeScriptHandler,
    };

    /**
     * This defines what is to be executed before all other steps.
     * @param flow - The user flow to execute
     */
    override async beforeAllSteps(flow: UserFlow): Promise<void> {
        await super.beforeAllSteps?.(flow);
    }

    /**
     * This defines what is to be executed before each step.
     * @param step - The current step
     * @param flow - The user flow
     */
    override async beforeEachStep(step: Step, flow: UserFlow): Promise<void> {
        if (step.type === 'customStep' && Object.hasOwnProperty.call(Extension.customStepHandler, step.name)) {
            await Extension.customStepHandler[step.name as keyof CustomStepHandler](step, this.page);
        }
        await super.beforeEachStep?.(step, flow);
    }

    /**
     * This defines what is to be executed after each step.
     * @param step - The current step
     * @param flow - The user flow
     */
    override async afterEachStep(step: Step, flow: UserFlow): Promise<void> {
        await super.afterEachStep?.(step, flow);
    }

    /**
     * This defines what is to be executed after all steps.
     * @param flow - The user flow
     */
    override async afterAllSteps(flow: UserFlow): Promise<void> {
        await super.afterAllSteps?.(flow);
    }
}

/**
 * This runs the pptr recording in the context of the given browser and page.
 * @param browser - The Puppeteer browser instance
 * @param page - The Puppeteer page instance
 * @param pptrJsonRecordingPath - Path to the Puppeteer recording JSON file
 */
async function authenticate(
    browser: Browser,
    page: Page,
    pptrJsonRecordingPath: string
): Promise<void> {
    const pptrJson = fs.readFileSync(pptrJsonRecordingPath, {
        encoding: 'utf8',
        flag: 'r'
    });

    const runner = await createRunner(
        JSON.parse(pptrJson),
        new Extension(browser, page, { timeout: 30000 }),
    );

    await runner.run();
}

export default authenticate;
