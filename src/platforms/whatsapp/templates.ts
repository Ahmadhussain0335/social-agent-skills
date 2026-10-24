import type { GraphClient } from '../meta/graph';

// https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview
export const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
export const CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'] as const;

export interface TemplateComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
  format?: string;
  text?: string;
  example?: Record<string, unknown>;
  buttons?: unknown[];
}

export interface TemplateDraft {
  name: string;
  language: string;
  category: (typeof CATEGORIES)[number];
  parameter_format?: 'positional' | 'named';
  components: TemplateComponent[];
}

export interface TemplateCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([\w]+)\s*\}\}/g)].map((m) => m[1] as string);
}

export function checkTemplate(raw: unknown): TemplateCheck {
  const t = (raw ?? {}) as Partial<TemplateDraft>;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!t.name || !TEMPLATE_NAME.test(t.name))
    errors.push('name must use only lowercase letters, digits and underscores');
  if (!t.language || !/^[a-z]{2,3}(_[A-Z]{2})?$/.test(t.language))
    errors.push('language must look like "en" or "en_US"');
  if (!t.category || !CATEGORIES.includes(t.category)) errors.push(`category must be one of ${CATEGORIES.join(', ')}`);
  if (t.parameter_format && !['positional', 'named'].includes(t.parameter_format)) {
    errors.push('parameter_format must be "positional" or "named"');
  }

  const components = Array.isArray(t.components) ? t.components : [];
  const body = components.find((c) => c.type === 'BODY');
  if (!body?.text?.trim()) errors.push('a BODY component with text is required');

  for (const component of components) {
    const vars = placeholders(component.text ?? '');
    if (vars.length === 0) continue;
    const positional = vars.every((v) => /^\d+$/.test(v));
    const named = vars.every((v) => /^[a-z_][a-z0-9_]*$/.test(v) && !/^\d+$/.test(v));
    if ((t.parameter_format ?? 'positional') === 'positional') {
      if (!positional) errors.push(`${component.type} uses named variables; set parameter_format to "named"`);
      else if (vars.some((v, i) => Number(v) !== i + 1)) {
        errors.push(`${component.type} positional variables must be {{1}}, {{2}}, ... in order`);
      }
    } else if (!named) {
      errors.push(`${component.type} named variables must be lowercase with underscores`);
    }
    if (!component.example)
      warnings.push(`${component.type} has variables but no example values; Meta usually rejects that`);
    if (/^\s*\{\{|\}\}\s*$/.test(component.text ?? '')) {
      warnings.push(`${component.type} starts or ends with a variable; Meta may reject it`);
    }
  }

  if (t.category === 'UTILITY' && /\b(sale|discount|offer|promo|deal|% off)\b/i.test(body?.text ?? '')) {
    warnings.push('promotional wording in a UTILITY template: Meta will approve it as MARKETING, which costs more');
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function submitTemplate(client: GraphClient, wabaId: string, draft: TemplateDraft): Promise<unknown> {
  return client.post(`${wabaId}/message_templates`, {
    name: draft.name,
    language: draft.language,
    category: draft.category,
    parameter_format: draft.parameter_format,
    components: JSON.stringify(draft.components),
  });
}

export interface TemplateStatus {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  quality_score?: { score?: string };
  rejected_reason?: string;
}

export async function listTemplates(client: GraphClient, wabaId: string, name?: string): Promise<TemplateStatus[]> {
  const res = (await client.get(`${wabaId}/message_templates`, {
    fields: 'id,name,language,status,category,quality_score,rejected_reason',
    name,
    limit: 100,
  })) as { data?: TemplateStatus[] };
  return res.data ?? [];
}
