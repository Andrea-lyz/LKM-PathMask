obj-m := pathmask.o procguard.o

KDIR := $(KDIR)
MDIR := $(realpath $(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
VER ?= local
ODIR := $(MDIR)/out/$(VER)

DEPS := KallRecon
ifneq ($(MAKECMDGOALS),format)
include $(MDIR)/mk/deps.mk
endif

pathmask-y := src/pathmask.o $(DEPS_OBJS_ALL)
procguard-y := src/procguard.o

ccflags-y += -std=gnu11
ccflags-y += -Wno-declaration-after-statement
ccflags-y += -Wno-unused-function
ccflags-y += -Wno-strict-prototypes
ccflags-y += -Wno-int-conversion
ccflags-y += -Wno-gcc-compat
ccflags-y += -Wno-missing-prototypes
ccflags-y += $(addprefix -I$(src)/,$(DEPS_INCS_ALL))

$(info -- KDIR: $(KDIR))
$(info -- MDIR: $(MDIR))
$(info -- ODIR: $(ODIR))

.PHONY: all clean format

all:
	make -C $(KDIR) M=$(ODIR) src=$(MDIR) srcroot=$(MDIR) modules
clean:
	make -C $(KDIR) M=$(ODIR) src=$(MDIR) srcroot=$(MDIR) clean

format:
	find src \( -name "*.c" -o -name "*.h" \) -print0 | xargs -0 clang-format -i

$(obj)/%.o: $(src)/%.c $(recordmcount_source) FORCE
	$(call if_changed_rule,cc_o_c)
	$(call cmd,force_checksrc)

$(obj)/%.o: $(src)/%.S FORCE
	$(call if_changed_rule,as_o_S)
