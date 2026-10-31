"""A bounded, presentation-only tool for evidence-led explorer findings."""

def text_schema(limit):
    return {"type": "string", "minLength": 1, "maxLength": limit}


REPORT_TOOL = {
    "name": "present_findings",
    "description": "Present a substantial investigation as a readable answer with expandable evidence, outside the tool trace. Use after reading data for neuron explanations, circuit investigations, or experiment comparisons. Separate measured observations from interpretation, state uncertainty, link relevant neurons/heads, and offer up to three specific next questions/tests. This only presents your assessment; it does not run tests, highlight units, or save names. The summary must explain the result in plain language with a concrete example; caveats remain visible. Next-step labels must name specific tests or questions in ordinary language. Do not force a one-job verdict or announce that a card was presented. Do not repeat the full card as prose afterwards.",
    "inputSchema": {"type": "object", "additionalProperties": False, "properties": {
        "title": text_schema(120), "summary": text_schema(1200),
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
        "evidence": {"type": "array", "minItems": 1, "maxItems": 8, "items": {
            "type": "object", "additionalProperties": False, "properties": {
                "source": text_schema(60), "text": text_schema(1200),
                "kind": {"type": "string", "enum": ["observation", "interpretation"]}},
            "required": ["source", "text", "kind"]}},
        "caveats": {"type": "array", "maxItems": 4, "items": text_schema(600)},
        "references": {"type": "array", "maxItems": 12, "items": {"type": "object", "additionalProperties": False,
            "properties": {"layer": {"type": "integer"}, "n": {"type": "integer"},
                           "kind": {"type": "string", "enum": ["neuron", "head"]}}, "required": ["layer", "n", "kind"]}},
        "next_steps": {"type": "array", "maxItems": 3, "items": {"type": "object", "additionalProperties": False,
            "properties": {"label": text_schema(70), "prompt": text_schema(800)}, "required": ["label", "prompt"]}},
    }, "required": ["title", "summary", "confidence", "evidence", "caveats", "references", "next_steps"]},
}


def validate_findings(value, arch):
    def check(data, schema):
        kind = schema['type']
        if kind == 'object':
            if not isinstance(data, dict) or set(data) - set(schema['properties']) or any(k not in data for k in schema.get('required', [])):
                raise ValueError('findings fields do not match the report schema')
            return {k: check(v, schema['properties'][k]) for k, v in data.items()}
        if kind == 'array':
            if not isinstance(data, list) or not schema.get('minItems', 0) <= len(data) <= schema['maxItems']:
                raise ValueError('findings list is missing or too long')
            return [check(v, schema['items']) for v in data]
        if kind == 'integer':
            if type(data) is not int:
                raise ValueError('unit indices must be integers')
        elif not isinstance(data, str) or not schema.get('minLength', 0) <= len(data.strip()) <= schema.get('maxLength', 100):
            raise ValueError('findings text is missing or too long')
        if 'enum' in schema and data not in schema['enum']:
            raise ValueError('invalid findings category')
        return data.strip() if isinstance(data, str) else data
    report = check(value, REPORT_TOOL['inputSchema'])
    for unit in report['references']:
        layer, n = unit['layer'], unit['n']
        if not 0 <= layer < arch['n_layers']:
            raise ValueError('reference layer is outside the explored model')
        limit = arch['inter'] if unit['kind'] == 'neuron' else arch['attn_heads'] if arch['layer_types'][layer] == 'full_attention' else arch['linear_v_heads']
        if not 0 <= n < limit:
            raise ValueError('reference unit is outside the explored model')
    return report
