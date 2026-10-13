#pragma once

// JSON values (RFC 8259) for command descriptors, action files and, later, project files (docs/specs/commands-
// history.md, FORMAT_NOTES §21.1). Objects keep their members in the order they were added, so the same value always
// gives the same text and files read in a sensible order. Integers and real numbers are kept apart: an integer comes
// back as the same 64-bit integer, a real number as the same double.
//
// Text is UTF-8. Reading is strict: no comments, no trailing commas, no repeated keys, valid UTF-8 only, at most
// maxDepth levels of nesting; a UTF-8 byte order mark at the start is skipped. Real numbers are finite (JSON has no
// NaN or infinity): writing one that is not is an error.

#include <concepts>
#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <limits>
#include <stdexcept>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

namespace pf::json {

// Text that is not valid JSON (the message names the line and column), a value of the wrong type, a missing key, or
// a value that cannot be written.
class Error : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

enum class Type : std::uint8_t { Null, Bool, Int, Real, String, Array, Object };

// For messages: "null", "true or false", "an integer", "a number", "text", "a list", "an object".
[[nodiscard]] std::string_view describe(Type type);

class Value;
using Array = std::vector<Value>;

// An object: members in the order they were added, keys unique.
class Object {
public:
    struct Member; // {key, value}, defined below Value
    using const_iterator = std::vector<Member>::const_iterator;

    Object() = default;
    // Later members with a key seen before replace the earlier value.
    Object(std::initializer_list<Member> members);

    [[nodiscard]] bool empty() const;
    [[nodiscard]] std::size_t size() const;
    [[nodiscard]] bool contains(std::string_view key) const { return find(key) != nullptr; }
    // Null when there is no such key.
    [[nodiscard]] const Value* find(std::string_view key) const;
    [[nodiscard]] Value* find(std::string_view key);
    // Throws Error naming the key when it is missing.
    [[nodiscard]] const Value& at(std::string_view key) const;
    // Replaces the value of an existing key (which keeps its place) or adds the key at the end.
    void set(std::string key, Value value);
    // False when there was no such key.
    bool erase(std::string_view key);

    [[nodiscard]] const_iterator begin() const;
    [[nodiscard]] const_iterator end() const;

    // The same keys with equal values, in any order (JSON objects are unordered).
    friend bool operator==(const Object& a, const Object& b);

private:
    std::vector<Member> m_members;
};

class Value {
public:
    // The constructors are defined below Object::Member: constructing the variant needs every alternative complete.
    Value() = default; // null
    Value(std::nullptr_t /*null*/);
    Value(bool value);
    // Any integer type; unsigned values above the largest 64-bit signed integer throw Error.
    template <std::integral T>
        requires(!std::same_as<T, bool>)
    Value(T value);
    Value(double value);
    Value(std::string value);
    Value(std::string_view value);
    Value(const char* value);
    Value(Array value);
    Value(Object value);

    [[nodiscard]] Type type() const { return static_cast<Type>(m_data.index()); }
    [[nodiscard]] bool isNull() const { return type() == Type::Null; }
    [[nodiscard]] bool isBool() const { return type() == Type::Bool; }
    [[nodiscard]] bool isInt() const { return type() == Type::Int; }
    // An integer or a real number.
    [[nodiscard]] bool isNumber() const { return type() == Type::Int || type() == Type::Real; }
    [[nodiscard]] bool isString() const { return type() == Type::String; }
    [[nodiscard]] bool isArray() const { return type() == Type::Array; }
    [[nodiscard]] bool isObject() const { return type() == Type::Object; }

    // Each throws Error when the value has another type.
    [[nodiscard]] bool asBool() const;
    [[nodiscard]] std::int64_t asInt() const;
    // An integer or a real number, as a double.
    [[nodiscard]] double asNumber() const;
    [[nodiscard]] const std::string& asString() const;
    [[nodiscard]] const Array& asArray() const;
    [[nodiscard]] Array& asArray();
    [[nodiscard]] const Object& asObject() const;
    [[nodiscard]] Object& asObject();

    // Same type and equal contents; an integer never equals a real number (1 ≠ 1.0).
    friend bool operator==(const Value& a, const Value& b);

private:
    template <std::integral T>
    static std::int64_t toInt64(T value) {
        if constexpr (std::is_unsigned_v<T> && sizeof(T) >= sizeof(std::int64_t)) {
            if (value > static_cast<T>(std::numeric_limits<std::int64_t>::max())) {
                throw Error("integer too large for JSON: " + std::to_string(value));
            }
        }
        return static_cast<std::int64_t>(value);
    }

    // The order matches Type.
    std::variant<std::nullptr_t, bool, std::int64_t, double, std::string, Array, Object> m_data;
};

struct Object::Member {
    // A constructor rather than an aggregate, so objects read like JSON: Object{{"node", "Exposure1"}, {"input", 0}}.
    Member(std::string memberKey, Value memberValue) : key(std::move(memberKey)), value(std::move(memberValue)) {}

    std::string key;
    Value value;
};

inline Value::Value(std::nullptr_t /*null*/) {}
inline Value::Value(bool value) : m_data(value) {}
template <std::integral T>
    requires(!std::same_as<T, bool>)
Value::Value(T value) : m_data(toInt64(value)) {}
inline Value::Value(double value) : m_data(value) {}
inline Value::Value(std::string value) : m_data(std::move(value)) {}
inline Value::Value(std::string_view value) : m_data(std::string(value)) {}
inline Value::Value(const char* value) : m_data(std::string(value)) {}
inline Value::Value(Array value) : m_data(std::move(value)) {}
inline Value::Value(Object value) : m_data(std::move(value)) {}

struct WriteOptions {
    // 0: everything on one line, no spaces. Above 0: one member or element per line, indented by this many spaces per
    // level; lists of plain values (numbers, text) stay on one line.
    int indent = 0;
};

// Throws Error for a real number that is not finite or text that is not valid UTF-8.
[[nodiscard]] std::string write(const Value& value, const WriteOptions& options = {});

inline constexpr int maxDepth = 256;

// Throws Error, with the line and column, for text that is not one valid JSON value.
[[nodiscard]] Value parse(std::string_view text);

} // namespace pf::json
