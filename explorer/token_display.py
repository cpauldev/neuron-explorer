"""Lossless labels for isolated vocabulary tokens, never used to decode whole text."""


def _byte_alphabet():
    # Reversible ByteLevel alphabet used by GPT-2/Qwen tokenizers.
    values = list(range(33, 127)) + list(range(161, 173)) + list(range(174, 256))
    characters = values.copy()
    next_codepoint = 256
    for value in range(256):
        if value not in values:
            values.append(value)
            characters.append(next_codepoint)
            next_codepoint += 1
    return {chr(character): value for character, value in zip(characters, values)}


BYTE_VALUES = _byte_alphabet()


def token_label(decoded, raw, token_id, byte_level=False):
    """Keep valid Unicode; show exact bytes when an isolated token cannot form UTF-8."""
    if "\ufffd" not in decoded:
        return decoded
    if byte_level and raw and all(character in BYTE_VALUES for character in raw):
        data = bytes(BYTE_VALUES[character] for character in raw)
        try:
            return data.decode("utf-8").replace("\ufffd", r"\uFFFD")
        except UnicodeDecodeError:
            return "bytes:" + " ".join(f"{value:02X}" for value in data)
    # Other tokenizer families must not be guessed to use the ByteLevel alphabet.
    escaped = (raw or decoded).replace("\ufffd", r"\uFFFD")
    return f"token:{token_id} ({escaped})"
