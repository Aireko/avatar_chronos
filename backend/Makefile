
CC := gcc
AR := ar

ROOT := ..
NODE_MODULES := $(ROOT)/node_modules
TS_ROOT := $(NODE_MODULES)/tree-sitter/vendor/tree-sitter/lib
TS_INCLUDE := $(TS_ROOT)/include
TS_SOURCE := $(TS_ROOT)/src/lib.c

BUILD := .build
CFLAGS := -std=c11 -Wall -Wextra -pedantic \
          -fsanitize=undefined -fno-sanitize-recover=all \
          -Iinclude -I$(TS_INCLUDE)

LDFLAGS := -fsanitize=undefined

SOURCES := $(wildcard src/*.c)
TESTS := $(wildcard tests/test_*.c)
TEST_BINS := $(patsubst tests/%.c,$(BUILD)/%,$(TESTS))

GRAMMAR_DIRS := \
  $(NODE_MODULES)/tree-sitter-c/src \
  $(NODE_MODULES)/tree-sitter-rust/src \
  $(NODE_MODULES)/tree-sitter-javascript/src \
  $(NODE_MODULES)/tree-sitter-typescript/typescript/src \
  $(NODE_MODULES)/tree-sitter-typescript/tsx/src

TS_LIB := $(BUILD)/libtree-sitter-bundle.a

.PHONY: all test clean

all: $(TEST_BINS)

$(BUILD):
	mkdir -p $(BUILD)

$(TS_LIB): $(TS_SOURCE) | $(BUILD)
	@set -eu; \
	$(CC) -std=c11 -D_DEFAULT_SOURCE -w \
	  -I$(TS_INCLUDE) -I$(TS_ROOT)/src \
	  -c $(TS_SOURCE) -o $(BUILD)/runtime.o; \
	objects="$(BUILD)/runtime.o"; \
	i=0; \
	for dir in $(GRAMMAR_DIRS); do \
	  test -f "$$dir/parser.c" || { \
	    echo "Missing grammar: $$dir/parser.c"; exit 1; \
	  }; \
	  i=$$((i + 1)); \
	  $(CC) -std=c11 -w -I$(TS_INCLUDE) -I"$$dir" \
	    -c "$$dir/parser.c" -o "$(BUILD)/grammar_$$i.o"; \
	  objects="$$objects $(BUILD)/grammar_$$i.o"; \
	  if test -f "$$dir/scanner.c"; then \
	    $(CC) -std=c11 -w -I$(TS_INCLUDE) -I"$$dir" \
	      -c "$$dir/scanner.c" -o "$(BUILD)/scanner_$$i.o"; \
	    objects="$$objects $(BUILD)/scanner_$$i.o"; \
	  fi; \
	done; \
	$(AR) rcs "$@" $$objects

$(BUILD)/test_%: tests/test_%.c $(SOURCES) $(TS_LIB)
	$(CC) $(CFLAGS) $(SOURCES) $< \
	  $(TS_LIB) $(LDFLAGS) -o $@

test: all
	@set -e; \
	for bin in $(TEST_BINS); do \
	  echo "Running $$bin"; \
	  "./$$bin"; \
	done

clean:
	rm -rf $(BUILD)
