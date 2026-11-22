import chalk from 'chalk';
import path from 'path';
import { randomUUID } from 'crypto';
import { Page, ElementHandle } from 'puppeteer';
import {
    CrawlInput as CrawlInputInterface,
    CrawlInputInterface as CrawlInputClassInterface,
    CrawlState,
    InputElementType,
    InputType,
    InputFieldDefinition,
    FileTypeDefinition,
    InputValues
} from '../types/input';

/**
 * The CrawlInput class specifies an input element in a CrawlState
 */
class CrawlInput implements CrawlInputInterface, CrawlInputClassInterface {
    /**
     * Static configuration for supported input fields
     */
    static readonly INPUT_FIELDS: InputFieldDefinition[] = [
        { ELEMENT: 'input', TYPE: 'text', CSS_PATH: 'input[type="text"]' },
        { ELEMENT: 'input', TYPE: 'email', CSS_PATH: 'input[type="email"]' },
        { ELEMENT: 'input', TYPE: 'password', CSS_PATH: 'input[type="password"]' },
        { ELEMENT: 'input', TYPE: 'search', CSS_PATH: 'input[type="search"]' },
        { ELEMENT: 'input', TYPE: 'url', CSS_PATH: 'input[type="url"]' },
        { ELEMENT: 'input', TYPE: 'checkbox', CSS_PATH: 'input[type="checkbox"]' },
        { ELEMENT: 'input', TYPE: 'radio', CSS_PATH: 'input[type="radio"]' },
        { ELEMENT: 'input', TYPE: 'file', CSS_PATH: 'input[type="file"]' },
        { ELEMENT: 'textarea', TYPE: null, CSS_PATH: 'textarea' },
        { ELEMENT: 'select', TYPE: null, CSS_PATH: 'select' },
    ];

    /**
     * Extra input selectors used for discovery and filling **only** — kept out
     * of {@link INPUT_FIELDS} on purpose (SCAN-200 / SCAN-194 RC1).
     *
     * A bare `<input>` (no `type` attribute) is a text field by default, but the
     * explicit-type selectors above never match it, so the crawler used to never
     * fill it — a required bare input then blocks the form's submit and the field
     * never gets the crawler's marker for reflected-XSS / SQLi testing.
     *
     * It cannot simply be added to `INPUT_FIELDS` because that list also feeds
     * `DomStripper`'s interactable set (via `Crawler.allInteractables`), and the
     * stripper removes the `type` attribute before re-testing interactability —
     * so an `input:not([type])` selector there would match *every* type-stripped
     * input (submit, text, …), keep them all, and silently repartition the crawl
     * graph (its output feeds `stateHash`). Discovery runs against the live DOM
     * where the distinction still holds, so this belongs here, not there.
     */
    static readonly DISCOVERY_ONLY_INPUT_FIELDS: InputFieldDefinition[] = [
        { ELEMENT: 'input', TYPE: 'text', CSS_PATH: 'input:not([type])' },
    ];

    /**
     * Static configuration for input values
     */
    static readonly VALUES: InputValues = {
        inputText: 'Sasori',
        inputEmail: 'sasori@hiddensand.bot',
        inputPassword: 'sas0riOfTheH!dd3nSand',
        inputSearch: 'Sasori',
        inputUrl: 'https://www.hiddensand.bot/',
    };

    /**
     * Static configuration for supported file types
     */
    static readonly SUPPORTED_FILE_TYPES: Record<string, FileTypeDefinition> = {
        // Images by mime type
        'image/*': { TYPE: 'image', EXTENSION: '.png' },
        'image/avif': { TYPE: 'image', EXTENSION: '.avif' },
        'image/bmp': { TYPE: 'image', EXTENSION: '.bmp' },
        'image/gif': { TYPE: 'image', EXTENSION: '.gif' },
        'image/heic': { TYPE: 'image', EXTENSION: '.heic' },
        'image/ico': { TYPE: 'image', EXTENSION: '.ico' }, // This is erroneous and is not IANA-registered
        'image/icon': { TYPE: 'image', EXTENSION: '.ico' }, // This is erroneous and is not IANA-registered
        'image/jpeg': { TYPE: 'image', EXTENSION: '.jpeg' },
        'image/png': { TYPE: 'image', EXTENSION: '.png' },
        'image/svg+xml': { TYPE: 'image', EXTENSION: '.svg' },
        'image/tiff': { TYPE: 'image', EXTENSION: '.tiff' },
        'image/vnd.microsoft.icon': { TYPE: 'image', EXTENSION: '.ico' },
        'image/webp': { TYPE: 'image', EXTENSION: '.webp' },

        // Videos by mime type
        'video/*': { TYPE: 'video', EXTENSION: '.mp4' },
        'video/x-msvideo': { TYPE: 'video', EXTENSION: '.avi' },
        'video/x-flv': { TYPE: 'video', EXTENSION: '.flv' },
        'video/x-matroska': { TYPE: 'video', EXTENSION: '.mkv' },
        'video/quicktime': { TYPE: 'video', EXTENSION: '.mov' },
        'video/mp4': { TYPE: 'video', EXTENSION: '.mp4' },
        'video/webm': { TYPE: 'video', EXTENSION: '.webm' },
        'video/x-ms-wmv': { TYPE: 'video', EXTENSION: '.wmv' },

        // Audios by mime type
        'audio/*': { TYPE: 'audio', EXTENSION: '.mp3' },
        'audio/aac': { TYPE: 'audio', EXTENSION: '.aac' },
        'audio/amr': { TYPE: 'audio', EXTENSION: '.amr' },
        'audio/flac': { TYPE: 'audio', EXTENSION: '.flac' },
        'audio/mp3': { TYPE: 'audio', EXTENSION: '.mp3' },
        'audio/ogg': { TYPE: 'audio', EXTENSION: '.ogg' },

        // Applications by mime type
        'application/*': { TYPE: 'application', EXTENSION: '.pdf' },
        'application/gzip': { TYPE: 'application', EXTENSION: '.gz' },
        'application/pdf': { TYPE: 'application', EXTENSION: '.pdf' },
        'application/xml': { TYPE: 'application', EXTENSION: '.xml' },
        'application/yaml': { TYPE: 'application', EXTENSION: '.yaml' },
        'application/zip': { TYPE: 'application', EXTENSION: '.zip' },

        // Texts by mime type
        'text/*': { TYPE: 'text', EXTENSION: '.txt' },
        'text/css': { TYPE: 'text', EXTENSION: '.css' },
        'text/csv': { TYPE: 'text', EXTENSION: '.csv' },
        'text/html': { TYPE: 'text', EXTENSION: '.html' },
        'text/javascript': { TYPE: 'text', EXTENSION: '.js' },
        'text/plain': { TYPE: 'text', EXTENSION: '.txt' },

        // Images by extension
        '.avif': { TYPE: 'image', EXTENSION: '.avif' },
        '.bmp': { TYPE: 'image', EXTENSION: '.bmp' },
        '.gif': { TYPE: 'image', EXTENSION: '.gif' },
        '.heic': { TYPE: 'image', EXTENSION: '.heic' },
        '.ico': { TYPE: 'image', EXTENSION: '.ico' },
        '.jpeg': { TYPE: 'image', EXTENSION: '.jpeg' },
        '.jpg': { TYPE: 'image', EXTENSION: '.jpg' },
        '.png': { TYPE: 'image', EXTENSION: '.png' },
        '.svg': { TYPE: 'image', EXTENSION: '.svg' },
        '.tiff': { TYPE: 'image', EXTENSION: '.tiff' },
        '.webp': { TYPE: 'image', EXTENSION: '.webp' },

        // Videos by extension
        '.avi': { TYPE: 'video', EXTENSION: '.avi' },
        '.flv': { TYPE: 'video', EXTENSION: '.flv' },
        '.mkv': { TYPE: 'video', EXTENSION: '.mkv' },
        '.mov': { TYPE: 'video', EXTENSION: '.mov' },
        '.mp4': { TYPE: 'video', EXTENSION: '.mp4' },
        '.webm': { TYPE: 'video', EXTENSION: '.webm' },
        '.wmv': { TYPE: 'video', EXTENSION: '.wmv' },

        // Audios by extension
        '.aac': { TYPE: 'audio', EXTENSION: '.aac' },
        '.amr': { TYPE: 'audio', EXTENSION: '.amr' },
        '.flac': { TYPE: 'audio', EXTENSION: '.flac' },
        '.mp3': { TYPE: 'audio', EXTENSION: '.mp3' },
        '.ogg': { TYPE: 'audio', EXTENSION: '.ogg' },

        // Applications by extension
        '.gz': { TYPE: 'application', EXTENSION: '.gz' },
        '.pdf': { TYPE: 'application', EXTENSION: '.pdf' },
        '.xml': { TYPE: 'application', EXTENSION: '.xml' },
        '.yaml': { TYPE: 'application', EXTENSION: '.yaml' },
        '.zip': { TYPE: 'application', EXTENSION: '.zip' },

        // Text by extension
        '.css': { TYPE: 'text', EXTENSION: '.css' },
        '.csv': { TYPE: 'text', EXTENSION: '.csv' },
        '.html': { TYPE: 'text', EXTENSION: '.html' },
        '.js': { TYPE: 'text', EXTENSION: '.js' },
        '.txt': { TYPE: 'text', EXTENSION: '.txt' },
    };

    /**
     * Unique identifier for this input
     */
    public readonly inputId: string;

    /**
     * The element type this input targets
     */
    public readonly element: InputElementType;

    /**
     * The input type (for input elements)
     */
    public readonly type: InputType | null;

    /**
     * CSS path to locate the element
     */
    public readonly cssPath: string;

    /**
     * The parent state from which this input originates
     */
    public readonly parentState: CrawlState;

    /**
     * CrawlInput object constructor
     * @param element - The element type this input targets
     * @param type - The input type (for input elements)
     * @param cssPath - CSS path to locate the element
     * @param parentState - The parent state from which this input originates
     */
    constructor(
        element: InputElementType,
        type: InputType | null,
        cssPath: string,
        parentState: CrawlState
    ) {
        // Validate required parameters
        if (!element || typeof element !== 'string' || element.trim() === '') {
            throw new Error('Element must be a non-empty string');
        }
        if (type !== null && (!type || typeof type !== 'string' || type.trim() === '')) {
            throw new Error('Type must be null or a non-empty string');
        }
        if (!cssPath || typeof cssPath !== 'string' || cssPath.trim() === '') {
            throw new Error('CSS path must be a non-empty string');
        }
        if (!parentState) {
            throw new Error('Parent state is required');
        }

        // Validate element type
        const validElements: InputElementType[] = ['input', 'textarea', 'select'];
        if (!validElements.includes(element as InputElementType)) {
            throw new Error(`Element must be one of: ${validElements.join(', ')}`);
        }

        // Validate input type if provided
        if (type !== null) {
            const validTypes: InputType[] = ['text', 'email', 'password', 'search', 'url', 'checkbox', 'radio', 'file'];
            if (!validTypes.includes(type as InputType)) {
                throw new Error(`Type must be one of: ${validTypes.join(', ')}`);
            }
        }

        this.inputId = randomUUID();
        this.element = element;
        this.type = type;
        this.cssPath = cssPath;
        this.parentState = parentState;
    }

    /**
     * Returns the parentState associated with the CrawlInput
     * @returns The parent state from which this input originates
     */
    getParentState(): CrawlState {
        return this.parentState;
    }

    /**
     * Checks the accept attribute of the <input> element with the given CSS path and returns an appropriate file path
     * @param page - Puppeteer page object
     * @param cssPath - CSS selector for the input element
     * @returns Promise resolving to the file path to upload
     */
    async getFilePath(page: Page, cssPath: string): Promise<string> {
        try {
            const acceptedFileTypes = await page.$eval(cssPath, (element: Element) =>
                element.getAttribute('accept')
            );
            const fileName = 'sasori';
            const defaultFile = path.join('resources', 'uploadFiles', 'image', `${fileName}.png`);

            if (acceptedFileTypes === null) {
                return defaultFile;
            }

            for (const acceptedFileType of acceptedFileTypes.split(',')) {
                const trimmedType = acceptedFileType.trim();
                if (Object.prototype.hasOwnProperty.call(CrawlInput.SUPPORTED_FILE_TYPES, trimmedType)) {
                    const fileType = CrawlInput.SUPPORTED_FILE_TYPES[trimmedType];
                    if (fileType) {
                        return path.join('resources', 'uploadFiles', fileType.TYPE, `${fileName}${fileType.EXTENSION}`);
                    }
                }
            }

            return defaultFile;
        } catch (error) {
            console.error(chalk.red(`[ERROR] Failed to get file path for selector: ${cssPath}`));
            console.error(chalk.red(`[ERROR] ${error instanceof Error ? error.message : 'Unknown error'}`));
            const fileName = 'sasori';
            return path.join('resources', 'uploadFiles', 'image', `${fileName}.png`);
        }
    }

    /**
     * Handles all input fields on the given page
     * @param page - Puppeteer page object
     */
    async inputFieldHandler(page: Page): Promise<void> {
        switch (this.element) {
            case 'input':
                await this.inputHandler(page);
                break;
            case 'textarea':
                await this.textareaHandler(page);
                break;
            case 'select':
                await this.selectHandler(page);
                break;
            default:
                console.warn(chalk.yellow(`[WARNING] Unsupported element type: ${this.element}`));
                break;
        }
    }

    /**
     * Types `value` into a field after clearing any pre-existing content.
     *
     * A bare `node.type()` *appends* — it does not replace. That is silently
     * wrong on the authenticated forms the crawler exists to exercise, because
     * they arrive *prefilled*: an account-settings page renders the current
     * name and email as the fields' values. Appending our probe string to a
     * real email yields `sasori@hiddensand.botbuyer1@host` — two `@`, which
     * fails the `<input type="email">` constraint, so the browser refuses to
     * submit the whole form and the `POST` endpoint we are trying to reach is
     * never hit (SCAN-201). Selecting the existing content first makes the
     * first keystroke replace it; doing it through a real selection plus
     * keystrokes (rather than assigning `value = ''`) keeps controlled,
     * React-style inputs in sync, which a raw value write would not.
     * @param node - The resolved input/textarea element handle.
     * @param value - The value to type once the field is cleared.
     */
    private async replaceValue(node: ElementHandle<Element>, value: string): Promise<void> {
        await node.focus();
        await node.evaluate((el) => {
            // `el` is a plain `Element` to the compiler (no DOM lib in this
            // tsconfig); an input/textarea exposes `select()` to highlight its
            // whole value, so the following `type()` overwrites it.
            const field = el as unknown as { select?: () => void };
            if (typeof field.select === 'function') {
                field.select();
            }
        });
        await node.type(value);
    }

    /**
     * Handles all input elements on the given page
     * @param page - Puppeteer page object
     */
    async inputHandler(page: Page): Promise<void> {
        let node;
        try {
            node = await page.waitForSelector(this.cssPath);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.error(chalk.red(`[ERROR] Could not find a node with the selector: ${this.cssPath}`));
            console.error(chalk.red(`[ERROR] ${errorMessage}`));
            return;
        }

        if (!node) {
            console.error(chalk.red(`[ERROR] Node not found for selector: ${this.cssPath}`));
            return;
        }

        switch (this.type) {
            case 'text':
                try {
                    await this.replaceValue(node, CrawlInput.VALUES.inputText);
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    console.error(chalk.red(`\n[ERROR] ${errorMessage}`));
                }
                break;

            case 'email':
                try {
                    await this.replaceValue(node, CrawlInput.VALUES.inputEmail);
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    console.error(chalk.red(`\n[ERROR] ${errorMessage}`));
                }
                break;

            case 'password':
                try {
                    await this.replaceValue(node, CrawlInput.VALUES.inputPassword);
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    console.error(chalk.red(`\n[ERROR] ${errorMessage}`));
                }
                break;

            case 'search':
                try {
                    await this.replaceValue(node, CrawlInput.VALUES.inputSearch);
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    console.error(chalk.red(`\n[ERROR] ${errorMessage}`));
                }
                break;

            case 'url':
                try {
                    await this.replaceValue(node, CrawlInput.VALUES.inputUrl);
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    console.error(chalk.red(`\n[ERROR] ${errorMessage}`));
                }
                break;

            case 'checkbox':
                try {
                    await node.click();
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    console.error(chalk.red(`\n[ERROR] ${errorMessage}`));
                }
                break;

            case 'radio':
                try {
                    await node.click();
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    console.error(chalk.red(`\n[ERROR] ${errorMessage}`));
                }
                break;

            case 'file':
                try {
                    const filePath = await this.getFilePath(page, this.cssPath);
                    await node.uploadFile(filePath);
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                    console.error(chalk.red(`\n[ERROR] ${errorMessage}`));
                }
                break;

            default:
                console.warn(chalk.yellow(`[WARNING] Unsupported input type: ${this.type}`));
                break;
        }
    }

    /**
     * Handles all textarea elements on the given page
     * @param page - Puppeteer page object
     */
    async textareaHandler(page: Page): Promise<void> {
        let node;
        try {
            node = await page.waitForSelector(this.cssPath);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.error(chalk.red(`[ERROR] Could not find a node with the selector: ${this.cssPath}`));
            console.error(chalk.red(`[ERROR] ${errorMessage}`));
            return;
        }

        if (!node) {
            console.error(chalk.red(`[ERROR] Node not found for selector: ${this.cssPath}`));
            return;
        }

        try {
            await this.replaceValue(node, CrawlInput.VALUES.inputText);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.error(chalk.red(`\n[ERROR] ${errorMessage}`));
        }
    }

    /**
     * Handles all select elements on the given page
     * @param page - Puppeteer page object
     */
    async selectHandler(page: Page): Promise<void> {
        let node;
        try {
            node = await page.waitForSelector(this.cssPath);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.error(chalk.red(`[ERROR] Could not find a node with the selector: ${this.cssPath}`));
            console.error(chalk.red(`[ERROR] ${errorMessage}`));
            return;
        }

        if (!node) {
            console.error(chalk.red(`[ERROR] Node not found for selector: ${this.cssPath}`));
            return;
        }

        try {
            const firstNonEmptyValue = await node.$$eval('option', (nodes: Element[]) => {
                for (const optionNode of nodes) {
                    const value = optionNode.getAttribute('value');
                    if (value !== null && value !== '') {
                        return value;
                    }
                }
                return null;
            });

            if (firstNonEmptyValue) {
                await page.select(this.cssPath, firstNonEmptyValue);
            } else {
                console.warn(chalk.yellow(`[WARNING] No valid option found for select: ${this.cssPath}`));
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.error(chalk.red(`\n[ERROR] ${errorMessage}`));
        }
    }

    /**
     * Returns a string representation of the CrawlInput
     * @returns String representation of the input
     */
    toString(): string {
        return `CrawlInput(${this.element}:${this.type || 'null'}@${this.cssPath})`;
    }

    /**
     * Returns a JSON representation of the CrawlInput
     * @returns JSON object representation of the input
     */
    toJSON(): Partial<CrawlInputInterface> {
        return {
            inputId: this.inputId,
            element: this.element,
            type: this.type,
            cssPath: this.cssPath,
            parentState: this.parentState,
        };
    }
}

export default CrawlInput;
