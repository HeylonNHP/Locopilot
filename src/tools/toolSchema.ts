export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolSchemaParameter>;
    required: string[];
  };
}

export interface ToolSchemaParameter {
  type: string;
  description?: string;
  enum?: string[];
  items?: { type: string };
}
