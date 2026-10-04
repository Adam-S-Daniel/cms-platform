#!/usr/bin/env ruby
# frozen_string_literal: true

# Minify a CloudFormation YAML template so deploy.sh can send it inline.
#
# WHY: template.yaml carries a lot of comment prose and is larger than the AWS
# CLI's 51,200-byte inline limit as written (60,694 bytes at v0.1.125, when the
# documented `bash infrastructure/bootstrap/deploy.sh` started failing).
# Comments and indentation are what make it big, and CloudFormation reads
# neither.
#
# HOW: a real YAML parse (Psych, Ruby's standard library, over libyaml) to the
# node tree, then a re-emit of that tree. The parser drops comments; the node
# tree keeps every tag (the short forms !Sub, !Ref, !If, !GetAtt ...), every
# scalar's exact value and its style (plain, quoted, literal or folded block),
# and key order. A line filter is not safe: block scalars such as a CloudFront
# FunctionCode body contain blank and "#" lines that belong to their value.
#
# SELF-CHECK: before writing anything, the output is parsed again and its node
# tree compared with the input's (tags, anchors, scalar values and styles,
# structure). Any difference is a refusal, so a deploy never sends a template
# that means something else. e2e/bootstrap-template-minify.test.js runs this
# same script and checks the result with a second, independent parser.
#
# Usage: ruby minify-template.rb <input.yaml> <output.yaml>
require "psych"

# A comparable fingerprint of a parsed YAML stream: everything a loader reads,
# nothing that is layout.
def fingerprint(node, out = [])
  case node
  when Psych::Nodes::Scalar
    out << [:scalar, node.tag, node.anchor, node.value, node.style]
  when Psych::Nodes::Mapping
    out << [:mapping, node.tag, node.anchor, node.children.size]
  when Psych::Nodes::Sequence
    out << [:sequence, node.tag, node.anchor, node.children.size]
  when Psych::Nodes::Alias
    out << [:alias, node.anchor]
  when Psych::Nodes::Document
    out << [:document, node.children.size]
  when Psych::Nodes::Stream
    out << [:stream, node.children.size]
  else
    raise ArgumentError, "unexpected YAML node #{node.class}"
  end
  (node.children || []).each { |child| fingerprint(child, out) }
  out
end

def fail_with(message)
  warn "minify-template.rb: #{message}"
  exit 1
end

input, output = ARGV
fail_with("usage: ruby minify-template.rb <input.yaml> <output.yaml>") unless ARGV.size == 2

# Read as UTF-8 whatever the locale: deploy.sh may run with no LANG at all.
source = File.read(input, mode: "r:UTF-8")
begin
  original = Psych.parse_stream(source)
  # line_width -1: never fold a long scalar onto a second line.
  minified = original.yaml(nil, line_width: -1)
  reparsed = Psych.parse_stream(minified)
rescue Psych::SyntaxError => e
  fail_with("#{input} is not valid YAML: #{e.message}")
end

unless fingerprint(reparsed) == fingerprint(Psych.parse_stream(source))
  fail_with("the minified template does not parse to the same YAML nodes as #{input}; refusing to write it")
end

File.write(output, minified, mode: "w:UTF-8")
