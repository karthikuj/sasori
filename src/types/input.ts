import { Page } from 'puppeteer';

/**
 * Represents an input element in a CrawlState
 */
export interface CrawlInput {
    inputId: string;
    element: InputElementType;
    type: InputType | null;
    cssPath: string;
    parentState: any; // Will be CrawlState when imported
}

/**
 * Represents an action that can be performed on a CrawlState
 */
export interface CrawlAction {
    actionId: string;
    element: string;
    cssPath: string;
    parentState: any; // Will be CrawlState when imported
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
 * CrawlInput class interface
 */
export interface CrawlInputInterface {
    inputId: string;
    element: InputElementType;
    type: InputType | null;
    cssPath: string;
    parentState: any; // Will be CrawlState when imported

    getParentState(): any; // Will be CrawlState when imported
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
