import { describe, it, expect } from 'vitest';
import {
    buildCreateTemplatePayload,
    orderedBodyVariables,
    validateForMeta,
    type CreatableTemplate,
} from '../whatsappTemplateCreate';

const base: CreatableTemplate = {
    metaTemplateId: 'statement_alert_v1',
    category: 'utility',
    language: 'en',
    body: 'Hi {{1}}, your balance is {{2}}. Thank you.',
    variables: ['1', '2'],
};
const examples = { body: { '1': 'Thabo', '2': 'R1 234.00' } };

describe('orderedBodyVariables', () => {
    it('orders positional variables numerically, not by appearance', () => {
        expect(orderedBodyVariables('A {{2}} b {{1}} c')).toEqual(['1', '2']);
    });
    it('keeps named variables in order of first appearance, deduplicated', () => {
        expect(orderedBodyVariables('A {{name}} b {{amount}} c {{name}} d')).toEqual(['name', 'amount']);
    });
});

describe('validateForMeta', () => {
    it('accepts a well-formed utility template', () => {
        expect(validateForMeta(base, examples)).toEqual([]);
    });
    it('rejects a name Meta would refuse', () => {
        expect(validateForMeta({ ...base, metaTemplateId: 'Statement Alert' }, examples).join()).toMatch(/lowercase/);
    });
    it('rejects a body that ends with a variable', () => {
        const errs = validateForMeta({ ...base, body: 'Your balance is {{1}}' }, { body: { '1': 'R1' } });
        expect(errs.join()).toMatch(/starts or ends with a variable/);
    });
    it('rejects gaps in positional variables', () => {
        const errs = validateForMeta({ ...base, body: 'Hi {{1}}, see {{3}} now.' }, { body: { '1': 'a', '3': 'b' } });
        expect(errs.join()).toMatch(/no gaps/);
    });
    it('rejects mixed positional and named variables', () => {
        const errs = validateForMeta({ ...base, body: 'Hi {{1}}, see {{amount}} now.' }, { body: { '1': 'a', amount: 'b' } });
        expect(errs.join()).toMatch(/one style only/);
    });
    it('requires a sample for every body variable', () => {
        expect(validateForMeta(base, { body: { '1': 'Thabo' } }).join()).toMatch(/\{\{2\}\}/);
    });
    it('requires a sample file for a media header', () => {
        expect(validateForMeta({ ...base, headerType: 'document' }, examples).join()).toMatch(/no sample file/);
    });
    it('requires a sample suffix for a dynamic URL button', () => {
        const t = { ...base, buttonType: 'url', buttonText: 'Pay now', buttonUrl: 'https://pay.example/p/{{1}}' };
        expect(validateForMeta(t, examples).join()).toMatch(/button #1/);
        expect(validateForMeta(t, { ...examples, button1: 'tok' })).toEqual([]);
    });
    it('refuses authentication templates', () => {
        expect(validateForMeta({ ...base, category: 'authentication' }, examples).join()).toMatch(/OTP/);
    });
});

describe('buildCreateTemplatePayload', () => {
    it('builds a positional body with examples in numeric order', () => {
        const p = buildCreateTemplatePayload(base, examples);
        expect(p).toMatchObject({ name: 'statement_alert_v1', language: 'en', category: 'UTILITY' });
        expect(p.parameter_format).toBeUndefined();
        expect(p.components).toEqual([
            { type: 'BODY', text: base.body, example: { body_text: [['Thabo', 'R1 234.00']] } },
        ]);
    });

    it('builds a named body with parameter_format NAMED', () => {
        const t = { ...base, body: 'Hi {{first_name}}, you owe {{amount}} today.', variables: ['first_name', 'amount'] };
        const p = buildCreateTemplatePayload(t, { body: { first_name: 'Thabo', amount: 'R5' } });
        expect(p.parameter_format).toBe('NAMED');
        expect((p.components as unknown[])[0]).toEqual({
            type: 'BODY',
            text: t.body,
            example: {
                body_text_named_params: [
                    { param_name: 'first_name', example: 'Thabo' },
                    { param_name: 'amount', example: 'R5' },
                ],
            },
        });
    });

    it('adds a document header from the handle and a dynamic + static button', () => {
        const t: CreatableTemplate = {
            ...base,
            headerType: 'document',
            headerUrl: 'https://x/y.pdf',
            buttonType: 'url',
            buttonText: 'Pay now',
            buttonUrl: 'https://pay.example/p/{{1}}',
            button2Type: 'url',
            button2Text: 'Website',
            button2Url: 'https://example.com',
        };
        const p = buildCreateTemplatePayload(t, { ...examples, button1: 'abc' }, 'HANDLE');
        const c = p.components as Array<Record<string, unknown>>;
        expect(c[0]).toEqual({ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: ['HANDLE'] } });
        expect(c[2]).toEqual({
            type: 'BUTTONS',
            buttons: [
                { type: 'URL', text: 'Pay now', url: 'https://pay.example/p/{{1}}', example: ['https://pay.example/p/abc'] },
                { type: 'URL', text: 'Website', url: 'https://example.com' },
            ],
        });
    });

    it('adds a static text header', () => {
        const p = buildCreateTemplatePayload({ ...base, headerType: 'text', headerText: 'Statement' }, examples);
        expect((p.components as unknown[])[0]).toEqual({ type: 'HEADER', format: 'TEXT', text: 'Statement' });
    });

    it('omits the body example when there are no variables', () => {
        const p = buildCreateTemplatePayload({ ...base, body: 'Thanks for paying.', variables: [] }, { body: {} });
        expect(p.components).toEqual([{ type: 'BODY', text: 'Thanks for paying.' }]);
    });
});
