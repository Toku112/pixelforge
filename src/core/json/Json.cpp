#include "core/json/Json.h"

#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <string>
#include <system_error>

#ifdef __APPLE__
#include <xlocale.h> // strtod_l, declared after <cstdlib>
#endif

namespace pf::json {
namespace {

// ---- UTF-8

// The length of the valid UTF-8 sequence starting at text[pos], or 0 when the bytes there are not valid UTF-8
// (overlong forms, surrogates and values above U+10FFFF are invalid).
std::size_t utf8SequenceLength(std::string_view text, std::size_t pos) {
    const auto byte = [&](std::size_t i) { return static_cast<unsigned char>(text[pos + i]); };
    const auto continuation = [&](std::size_t i, unsigned lo = 0x80, unsigned hi = 0xBF) {
        return pos + i < text.size() && byte(i) >= lo && byte(i) <= hi;
    };
    const unsigned lead = byte(0);
    if (lead < 0x80) {
        return 1;
    }
    if (lead >= 0xC2 && lead <= 0xDF) {
        return continuation(1) ? 2 : 0;
    }
    if (lead >= 0xE0 && lead <= 0xEF) {
        const unsigned lo = lead == 0xE0 ? 0xA0 : 0x80;
        const unsigned hi = lead == 0xED ? 0x9F : 0xBF; // no surrogates
        return continuation(1, lo, hi) && continuation(2) ? 3 : 0;
    }
    if (lead >= 0xF0 && lead <= 0xF4) {
        const unsigned lo = lead == 0xF0 ? 0x90 : 0x80;
        const unsigned hi = lead == 0xF4 ? 0x8F : 0xBF; // at most U+10FFFF
        return continuation(1, lo, hi) && continuation(2) && continuation(3) ? 4 : 0;
    }
    return 0;
}

void appendUtf8(std::string& out, std::uint32_t codePoint) {
    const auto put = [&](std::uint32_t byte) { out.push_back(static_cast<char>(byte)); };
    if (codePoint < 0x80) {
        put(codePoint);
    } else if (codePoint < 0x800) {
        put(0xC0 | (codePoint >> 6U));
        put(0x80 | (codePoint & 0x3FU));
    } else if (codePoint < 0x10000) {
        put(0xE0 | (codePoint >> 12U));
        put(0x80 | ((codePoint >> 6U) & 0x3FU));
        put(0x80 | (codePoint & 0x3FU));
    } else {
        put(0xF0 | (codePoint >> 18U));
        put(0x80 | ((codePoint >> 12U) & 0x3FU));
        put(0x80 | ((codePoint >> 6U) & 0x3FU));
        put(0x80 | (codePoint & 0x3FU));
    }
}

// ---- numbers

std::string formatReal(double value) {
    if (!std::isfinite(value)) {
        throw Error("JSON cannot hold NaN or infinity");
    }
    std::array<char, 32> buffer{};
    const std::to_chars_result result = std::to_chars(buffer.data(), buffer.data() + buffer.size(), value);
    std::string text(buffer.data(), result.ptr);
    // The shortest form of 2.0 is "2": add ".0" so it reads back as a real number, not an integer.
    if (text.find_first_of(".eE") == std::string::npos) {
        text += ".0";
    }
    return text;
}

// `token` is a JSON number with a fraction or an exponent. Locale-independent and correctly rounded.
bool parseReal(std::string_view token, double& value) {
#ifdef __APPLE__
    // std::from_chars for double needs macOS 26 (our minimum is 14); strtod_l with the C locale is the same
    // conversion. `token` is already checked against the JSON grammar, so strtod_l reads all of it.
    const std::string terminated(token);
    value = strtod_l(terminated.c_str(), nullptr, LC_C_LOCALE);
    return std::isfinite(value);
#else
    const std::from_chars_result result = std::from_chars(token.data(), token.data() + token.size(), value);
    if (result.ec == std::errc::result_out_of_range) {
        // Too small for a double: zero. Too large: an error.
        if (token.find("e-") == std::string_view::npos && token.find("E-") == std::string_view::npos) {
            return false;
        }
        value = token.starts_with('-') ? -0.0 : 0.0;
        return true;
    }
    return result.ec == std::errc{} && result.ptr == token.data() + token.size();
#endif
}

// ---- writing

void writeString(std::string& out, std::string_view text) {
    out.push_back('"');
    for (std::size_t pos = 0; pos < text.size();) {
        const char c = text[pos];
        const auto byte = static_cast<unsigned char>(c);
        if (byte >= 0x80) {
            const std::size_t length = utf8SequenceLength(text, pos);
            if (length == 0) {
                throw Error("text is not valid UTF-8");
            }
            out.append(text.substr(pos, length));
            pos += length;
            continue;
        }
        switch (c) {
        case '"':
            out += "\\\"";
            break;
        case '\\':
            out += "\\\\";
            break;
        case '\b':
            out += "\\b";
            break;
        case '\f':
            out += "\\f";
            break;
        case '\n':
            out += "\\n";
            break;
        case '\r':
            out += "\\r";
            break;
        case '\t':
            out += "\\t";
            break;
        default:
            if (byte < 0x20) {
                constexpr std::string_view hex = "0123456789abcdef";
                out += "\\u00";
                out.push_back(hex[byte >> 4U]);
                out.push_back(hex[byte & 0xFU]);
            } else {
                out.push_back(c);
            }
        }
        ++pos;
    }
    out.push_back('"');
}

bool isPlain(const Value& value) {
    return !value.isArray() && !value.isObject();
}

class Writer {
public:
    explicit Writer(const WriteOptions& options) : m_indent(std::max(0, options.indent)) {}

    void value(const Value& item, int level) {
        switch (item.type()) {
        case Type::Null:
            m_out += "null";
            break;
        case Type::Bool:
            m_out += item.asBool() ? "true" : "false";
            break;
        case Type::Int:
            m_out += std::to_string(item.asInt());
            break;
        case Type::Real:
            m_out += formatReal(item.asNumber());
            break;
        case Type::String:
            writeString(m_out, item.asString());
            break;
        case Type::Array:
            array(item.asArray(), level);
            break;
        case Type::Object:
            object(item.asObject(), level);
            break;
        }
    }

    [[nodiscard]] std::string take() { return std::move(m_out); }

private:
    void array(const Array& elements, int level) {
        const bool oneLine = m_indent == 0 || std::ranges::all_of(elements, isPlain);
        m_out.push_back('[');
        for (std::size_t i = 0; i < elements.size(); ++i) {
            if (i > 0) {
                m_out += (m_indent > 0 && oneLine) ? ", " : ",";
            }
            if (!oneLine) {
                newline(level + 1);
            }
            value(elements[i], level + 1);
        }
        if (!oneLine && !elements.empty()) {
            newline(level);
        }
        m_out.push_back(']');
    }

    void object(const Object& members, int level) {
        m_out.push_back('{');
        bool first = true;
        for (const auto& [key, member] : members) {
            if (!first) {
                m_out.push_back(',');
            }
            first = false;
            if (m_indent > 0) {
                newline(level + 1);
            }
            writeString(m_out, key);
            m_out += m_indent > 0 ? ": " : ":";
            value(member, level + 1);
        }
        if (m_indent > 0 && !members.empty()) {
            newline(level);
        }
        m_out.push_back('}');
    }

    void newline(int level) {
        m_out.push_back('\n');
        m_out.append(static_cast<std::size_t>(level) * static_cast<std::size_t>(m_indent), ' ');
    }

    int m_indent;
    std::string m_out;
};

// ---- reading

class Parser {
public:
    explicit Parser(std::string_view text) : m_text(text) {
        if (m_text.starts_with("\xEF\xBB\xBF")) {
            m_pos = 3;
        }
    }

    Value document() {
        skipSpace();
        Value result = value(0);
        skipSpace();
        if (m_pos != m_text.size()) {
            fail("unexpected text after the value");
        }
        return result;
    }

private:
    [[noreturn]] void fail(std::string_view message) const {
        std::size_t line = 1;
        std::size_t column = 1;
        for (std::size_t i = 0; i < m_pos && i < m_text.size(); ++i) {
            if (m_text[i] == '\n') {
                ++line;
                column = 1;
            } else if ((static_cast<unsigned char>(m_text[i]) & 0xC0U) != 0x80U) {
                ++column; // count characters, not UTF-8 continuation bytes
            }
        }
        throw Error("JSON line " + std::to_string(line) + ", column " + std::to_string(column) + ": " +
                    std::string(message));
    }

    [[nodiscard]] bool atEnd() const { return m_pos >= m_text.size(); }
    [[nodiscard]] char peek() const { return atEnd() ? '\0' : m_text[m_pos]; }

    void skipSpace() {
        while (!atEnd() && (peek() == ' ' || peek() == '\t' || peek() == '\n' || peek() == '\r')) {
            ++m_pos;
        }
    }

    void expect(char c) {
        if (atEnd() || peek() != c) {
            fail(std::string("expected '") + c + "'");
        }
        ++m_pos;
    }

    Value value(int depth) {
        if (depth >= maxDepth) {
            fail("nested too deeply");
        }
        switch (peek()) {
        case '{':
            return object(depth);
        case '[':
            return array(depth);
        case '"':
            return string();
        case 't':
            literal("true");
            return true;
        case 'f':
            literal("false");
            return false;
        case 'n':
            literal("null");
            return nullptr;
        default:
            if (peek() == '-' || (peek() >= '0' && peek() <= '9')) {
                return number();
            }
            fail(atEnd() ? "unexpected end of text" : "expected a value");
        }
    }

    void literal(std::string_view word) {
        if (m_text.substr(m_pos, word.size()) != word) {
            fail("expected a value");
        }
        m_pos += word.size();
    }

    Value object(int depth) {
        expect('{');
        Object result;
        skipSpace();
        if (peek() == '}') {
            ++m_pos;
            return result;
        }
        for (;;) {
            skipSpace();
            if (peek() != '"') {
                fail("expected a key in quotes");
            }
            const std::size_t keyPos = m_pos;
            std::string key = string();
            if (result.contains(key)) {
                m_pos = keyPos;
                fail("the key \"" + key + "\" appears twice");
            }
            skipSpace();
            expect(':');
            skipSpace();
            Value member = value(depth + 1);
            result.set(std::move(key), std::move(member));
            skipSpace();
            if (peek() == ',') {
                ++m_pos;
                continue;
            }
            expect('}');
            return result;
        }
    }

    Value array(int depth) {
        expect('[');
        Array result;
        skipSpace();
        if (peek() == ']') {
            ++m_pos;
            return result;
        }
        for (;;) {
            skipSpace();
            result.push_back(value(depth + 1));
            skipSpace();
            if (peek() == ',') {
                ++m_pos;
                continue;
            }
            expect(']');
            return result;
        }
    }

    std::uint32_t hex4() {
        std::uint32_t result = 0;
        for (int i = 0; i < 4; ++i) {
            const char c = peek();
            std::uint32_t digit = 0;
            if (c >= '0' && c <= '9') {
                digit = static_cast<std::uint32_t>(c - '0');
            } else if (c >= 'a' && c <= 'f') {
                digit = static_cast<std::uint32_t>(c - 'a' + 10);
            } else if (c >= 'A' && c <= 'F') {
                digit = static_cast<std::uint32_t>(c - 'A' + 10);
            } else {
                fail("\\u needs four hexadecimal digits");
            }
            result = (result * 16) + digit;
            ++m_pos;
        }
        return result;
    }

    void escape(std::string& out) {
        const char c = peek();
        ++m_pos;
        switch (c) {
        case '"':
        case '\\':
        case '/':
            out.push_back(c);
            return;
        case 'b':
            out.push_back('\b');
            return;
        case 'f':
            out.push_back('\f');
            return;
        case 'n':
            out.push_back('\n');
            return;
        case 'r':
            out.push_back('\r');
            return;
        case 't':
            out.push_back('\t');
            return;
        case 'u':
            break;
        default:
            --m_pos;
            fail("unknown escape sequence");
        }
        std::uint32_t codePoint = hex4();
        if (codePoint >= 0xDC00 && codePoint <= 0xDFFF) {
            fail("a low surrogate without a high one");
        }
        if (codePoint >= 0xD800 && codePoint <= 0xDBFF) {
            if (m_text.substr(m_pos, 2) != "\\u") {
                fail("a high surrogate must be followed by a low one");
            }
            m_pos += 2;
            const std::uint32_t low = hex4();
            if (low < 0xDC00 || low > 0xDFFF) {
                fail("a high surrogate must be followed by a low one");
            }
            codePoint = 0x10000 + ((codePoint - 0xD800) << 10U) + (low - 0xDC00);
        }
        appendUtf8(out, codePoint);
    }

    std::string string() {
        expect('"');
        std::string result;
        for (;;) {
            if (atEnd()) {
                fail("text in quotes is not closed");
            }
            const char c = peek();
            const auto byte = static_cast<unsigned char>(c);
            if (c == '"') {
                ++m_pos;
                return result;
            }
            if (c == '\\') {
                ++m_pos;
                escape(result);
            } else if (byte < 0x20) {
                fail("control characters in text must be escaped");
            } else {
                const std::size_t length = utf8SequenceLength(m_text, m_pos);
                if (length == 0) {
                    fail("text is not valid UTF-8");
                }
                result.append(m_text.substr(m_pos, length));
                m_pos += length;
            }
        }
    }

    void digits() {
        if (peek() < '0' || peek() > '9') {
            fail("expected a digit");
        }
        while (!atEnd() && peek() >= '0' && peek() <= '9') {
            ++m_pos;
        }
    }

    Value number() {
        const std::size_t start = m_pos;
        bool real = false;
        if (peek() == '-') {
            ++m_pos;
        }
        if (peek() == '0') {
            ++m_pos; // no leading zeros: "0" followed by a fraction, an exponent or nothing
        } else {
            digits();
        }
        if (peek() == '.') {
            ++m_pos;
            digits();
            real = true;
        }
        if (peek() == 'e' || peek() == 'E') {
            ++m_pos;
            if (peek() == '+' || peek() == '-') {
                ++m_pos;
            }
            digits();
            real = true;
        }
        const std::string_view token = m_text.substr(start, m_pos - start);
        if (!real) {
            std::int64_t integer = 0;
            const std::from_chars_result result = std::from_chars(token.data(), token.data() + token.size(), integer);
            if (result.ec == std::errc{} && result.ptr == token.data() + token.size()) {
                return integer;
            }
            // Beyond 64 bits: read as a real number.
        }
        double number = 0.0;
        if (!parseReal(token, number)) {
            m_pos = start;
            fail("number out of range");
        }
        return number;
    }

    std::string_view m_text;
    std::size_t m_pos = 0;
};

} // namespace

std::string_view describe(Type type) {
    switch (type) {
    case Type::Null:
        return "null";
    case Type::Bool:
        return "true or false";
    case Type::Int:
        return "an integer";
    case Type::Real:
        return "a number";
    case Type::String:
        return "text";
    case Type::Array:
        return "a list";
    case Type::Object:
        return "an object";
    }
    return "unknown";
}

// ---- Object

Object::Object(std::initializer_list<Member> members) {
    for (const Member& member : members) {
        set(member.key, member.value);
    }
}

bool Object::empty() const {
    return m_members.empty();
}

std::size_t Object::size() const {
    return m_members.size();
}

Object::const_iterator Object::begin() const {
    return m_members.begin();
}

Object::const_iterator Object::end() const {
    return m_members.end();
}

const Value* Object::find(std::string_view key) const {
    const auto found = std::ranges::find(m_members, key, &Member::key);
    return found == m_members.end() ? nullptr : &found->value;
}

Value* Object::find(std::string_view key) {
    const auto found = std::ranges::find(m_members, key, &Member::key);
    return found == m_members.end() ? nullptr : &found->value;
}

const Value& Object::at(std::string_view key) const {
    const Value* value = find(key);
    if (value == nullptr) {
        throw Error("missing \"" + std::string(key) + "\"");
    }
    return *value;
}

void Object::set(std::string key, Value value) {
    if (Value* existing = find(key)) {
        *existing = std::move(value);
        return;
    }
    m_members.emplace_back(std::move(key), std::move(value));
}

bool Object::erase(std::string_view key) {
    const auto found = std::ranges::find(m_members, key, &Member::key);
    if (found == m_members.end()) {
        return false;
    }
    m_members.erase(found);
    return true;
}

bool operator==(const Object& a, const Object& b) {
    if (a.size() != b.size()) {
        return false;
    }
    return std::ranges::all_of(a.m_members, [&](const Object::Member& member) {
        const Value* other = b.find(member.key);
        return other != nullptr && *other == member.value;
    });
}

// ---- Value

namespace {

[[noreturn]] void wrongType(Type expected, Type found) {
    throw Error("expected " + std::string(describe(expected)) + ", found " + std::string(describe(found)));
}

} // namespace

bool operator==(const Value& a, const Value& b) {
    return a.m_data == b.m_data;
}

bool Value::asBool() const {
    if (!isBool()) {
        wrongType(Type::Bool, type());
    }
    return std::get<bool>(m_data);
}

std::int64_t Value::asInt() const {
    if (!isInt()) {
        wrongType(Type::Int, type());
    }
    return std::get<std::int64_t>(m_data);
}

double Value::asNumber() const {
    if (isInt()) {
        return static_cast<double>(std::get<std::int64_t>(m_data));
    }
    if (type() != Type::Real) {
        wrongType(Type::Real, type());
    }
    return std::get<double>(m_data);
}

const std::string& Value::asString() const {
    if (!isString()) {
        wrongType(Type::String, type());
    }
    return std::get<std::string>(m_data);
}

const Array& Value::asArray() const {
    if (!isArray()) {
        wrongType(Type::Array, type());
    }
    return std::get<Array>(m_data);
}

Array& Value::asArray() {
    if (!isArray()) {
        wrongType(Type::Array, type());
    }
    return std::get<Array>(m_data);
}

const Object& Value::asObject() const {
    if (!isObject()) {
        wrongType(Type::Object, type());
    }
    return std::get<Object>(m_data);
}

Object& Value::asObject() {
    if (!isObject()) {
        wrongType(Type::Object, type());
    }
    return std::get<Object>(m_data);
}

// ---- entry points

std::string write(const Value& value, const WriteOptions& options) {
    Writer writer(options);
    writer.value(value, 0);
    return writer.take();
}

Value parse(std::string_view text) {
    return Parser(text).document();
}

} // namespace pf::json
