import { Page } from 'puppeteer';

/**
 * Represents the state of the DOM after an action (vertex in crawl graph)
 */
export interface CrawlState {
    stateId: string;
    url: string;
    stateHash: string;
    crawlDepth: number;
    arrivalType: ArrivalType;
    crawlInputs: CrawlInput[];
    crawlActions: CrawlAction[];

    getCrawlActions(): CrawlAction[];
    getCrawlDepth(): number;
    getCrawlInputs(): CrawlInput[];
    toString(): string;
    toJSON(): Partial<CrawlState>;
}

/**
 * Represents an input element in a CrawlState
 */
export interface CrawlInput {
    inputId: string;
    element: InputElementType;
    type: InputType | null;
    cssPath: string;
    parentState: CrawlState;
}

/**
 * Represents an action that can be performed on a CrawlState
 */
export interface CrawlAction {
    actionId: string;
    element: string;
    action: string;
    cssPath: string;
    actionHash: string;
    parentState: CrawlState;
    childState: CrawlState | null;
}

/**
 * Supported input element types
 */
export type InputElementType = 'input' | 'textarea' | 'select';

/**
 * Supported input types for input elements
 */
export type InputType =
    | 'text'
    | 'email'
    | 'password'
    | 'search'
    | 'url'
    | 'checkbox'
    | 'radio'
    | 'file';

/**
 * How a state was achieved: via a full page navigation by clicking a link, or via in-page DOM interactions.
 * Note: Root state is considered 'link'.
 */
export type ArrivalType = 'link' | 'dom';

/**
 * Input field definition for static configuration
 */
export interface InputFieldDefinition {
    ELEMENT: InputElementType;
    TYPE: InputType | null;
    CSS_PATH: string;
}

/**
 * File type definition for supported file uploads
 */
export interface FileTypeDefinition {
    TYPE: 'image' | 'video' | 'audio' | 'application' | 'text';
    EXTENSION: string;
}

/**
 * Input values for different field types
 */
export interface InputValues {
    inputText: string;
    inputEmail: string;
    inputPassword: string;
    inputSearch: string;
    inputUrl: string;
}

/**
 * CrawlAction class interface
 */
export interface CrawlActionInterface {
    actionId: string;
    element: string;
    action: string;
    cssPath: string;
    actionHash: string;
    parentState: CrawlState;
    childState: CrawlState | null;

    getParentState(): CrawlState;
    getChildState(): CrawlState | null;
}

/**
 * CrawlInput class interface
 */
export interface CrawlInputInterface {
    inputId: string;
    element: InputElementType;
    type: InputType | null;
    cssPath: string;
    parentState: CrawlState;

    getParentState(): CrawlState;
    getFilePath(page: Page, cssPath: string): Promise<string>;
    inputFieldHandler(page: Page): Promise<void>;
    inputHandler(page: Page): Promise<void>;
    textareaHandler(page: Page): Promise<void>;
    selectHandler(page: Page): Promise<void>;
}

/**
 * Static configuration for input fields
 */
export interface InputFieldConfig {
    INPUT_FIELDS: InputFieldDefinition[];
    VALUES: InputValues;
    SUPPORTED_FILE_TYPES: Record<string, FileTypeDefinition>;
}
