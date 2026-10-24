package identity

import (
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/zgeoff/impz/agent/internal/host/sysutil"
)

// The kernel changes boot_id on every cold boot and keeps it across a wake
// from memory; a restored boot template has the template's. Without procfs
// impd gets "" and records no cold boot.
func ReadBootID() string {
	b, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		log.Printf("boot: boot_id: %v", err)
		return ""
	}
	return strings.TrimSpace(string(b))
}

// Each copy of a boot template shares the kernel's boot_id, so this draws a
// random UUID instead, after the claim reseeded the CRNG.
func NewBootID() string {
	b := sysutil.NewUUID()
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
