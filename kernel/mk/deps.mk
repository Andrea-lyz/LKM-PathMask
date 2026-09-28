# deps.mk metadata per lib, vendored at deps/<Name>/
# builtin libs live in .sdk/builtin/<Name>/, the expander falls back
# to them when no vendored copy exists
#   DEPS_LIB_OBJS  relative to lib root
#   DEPS_LIB_INCS  relative to lib root
#   DEPS_LIB_DEPS  recursive, dedup by guard
# $$ defers to eval reparse, eval expands its argument before the
# assignment lines run, unescaped include would see an empty root
# objs stay relative so Kbuild resolves them against M=, the $(src)
# rules redirect the actual source files
SDK_ROOT ?= $(MDIR)/.sdk
DEPS_OBJS_ALL :=
DEPS_INCS_ALL :=

define dep_register
ifeq ($(DEPS_SEEN_$(1)),)
DEPS_SEEN_$(1) := 1
DEPS_LIB_ROOT := $(MDIR)/deps/$(1)
DEPS_LIB_PFX := deps/$(1)
ifeq ($$(wildcard $$(DEPS_LIB_ROOT)/deps.mk),)
DEPS_LIB_ROOT := $(SDK_ROOT)/builtin/$(1)
DEPS_LIB_PFX := .sdk/builtin/$(1)
endif
include $$(DEPS_LIB_ROOT)/deps.mk
DEPS_OBJS_ALL += $$(addprefix $$(DEPS_LIB_PFX)/,$$(DEPS_LIB_OBJS))
DEPS_INCS_ALL += $$(addprefix $$(DEPS_LIB_PFX)/,$$(DEPS_LIB_INCS))
$$(foreach d,$$(DEPS_LIB_DEPS),$$(eval $$(call dep_register,$$(d))))
endif
endef

$(foreach d,$(DEPS),$(eval $(call dep_register,$(d))))
