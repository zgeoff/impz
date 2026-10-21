package identity

import (
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/zgeoff/impz/agent/internal/sysutil"
)

// ReadBootID returns the guest kernel's boot_id, which every cold boot
// changes and a wake from memory keeps. Without procfs it is "", and impd
// keeps no cold boot for it. A restored boot template has the template's.
func ReadBootID() string {
	b, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		log.Printf("boot: boot_id: %v", err)
		return ""
	}
	return strings.TrimSpace(string(b))
}

// NewBootID names a claimed boot template's boot: each copy of the template
// shares the kernel's boot_id, so it draws a random UUID instead, after the
// claim reseeded the CRNG. A wake from memory keeps it, as it keeps boot_id.
func NewBootID() string {
	b := sysutil.NewUUID()
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
