export interface ScenarioFile {
  config?: {
    base_url?: string;
    timeout?: number;
  };
  scenarios: Scenario[];
}

export interface Scenario {
  name: string;
  tags?: string[];
  steps: Step[];
}

export type Step =
  | UploadFileStep
  | SendMessageStep
  | WaitForResponseStep
  | ClickStep
  | NavigateStep
  | VerifyStep
  | VerifyLlmStep;

export interface UploadFileStep {
  action: 'upload_file';
  file: string;
}

export interface SendMessageStep {
  action: 'send_message';
  input: string;
}

export interface WaitForResponseStep {
  action: 'wait_for_response';
  timeout?: number;
}

export interface ClickStep {
  action: 'click';
  selector: string;
}

export interface NavigateStep {
  action: 'navigate';
  path: string;
}

export interface VerifyStep {
  action: 'verify';
  expected: {
    contains?: string[];
    not_contains?: string[];
    has_chart?: boolean;
    has_table?: boolean;
    table_row_count_min?: number;
    element_exists?: string;
    element_not_exists?: string;
    css_property?: {
      selector: string;
      property: string;
      matches: string;
    };
  };
}

export interface VerifyLlmStep {
  action: 'verify_llm';
  criteria: string;
  pass_threshold?: number;
}
