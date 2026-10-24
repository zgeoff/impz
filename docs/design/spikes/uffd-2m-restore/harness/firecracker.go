package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// The devices impd's setupVm gives every VM: a template restore takes the
// snapshot's devices, so the build must configure the same ones.
const (
	rootfsDrive = "rootfs"
	systemDrive = "system"
	ifaceID     = "eth0"
	guestCID    = 3
)

type firecracker struct {
	cmd    *exec.Cmd
	client *http.Client
}

// startFirecracker runs Firecracker as impd does, with only --api-sock, and
// returns once the API socket accepts. Pdeathsig kills it with the harness.
func startFirecracker(bin, apiSocket, logFile string) (*firecracker, error) {
	log, err := os.Create(logFile)
	if err != nil {
		return nil, err
	}
	defer log.Close()

	cmd := exec.Command(bin, "--api-sock", apiSocket)
	cmd.Stdout = log
	cmd.Stderr = log
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	fc := &firecracker{
		cmd: cmd,
		client: &http.Client{Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var dialer net.Dialer
				return dialer.DialContext(ctx, "unix", apiSocket)
			},
		}},
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		conn, err := net.Dial("unix", apiSocket)
		if err == nil {
			conn.Close()
			return fc, nil
		}
		if time.Now().After(deadline) {
			fc.stop()
			return nil, fmt.Errorf("firecracker api socket: %w", err)
		}
		time.Sleep(time.Millisecond)
	}
}

func (fc *firecracker) stop() {
	_ = fc.cmd.Process.Kill()
	_ = fc.cmd.Wait()
}

func (fc *firecracker) send(method, path string, body any) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequest(method, "http://localhost"+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := fc.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	text, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%s %s: %d %s", method, path, resp.StatusCode, text)
	}
	return text, nil
}

type vmShape struct {
	kernel    string
	bootArgs  string
	vcpus     int
	memoryMiB int
	hugePages string
	rootfs    string
	system    string
	vsock     string
	tap       string
	guestMAC  string
}

// configure sends the requests of impd's setupVm, in its order, with
// huge_pages added when the shape asks for it.
func (fc *firecracker) configure(shape vmShape) error {
	machine := map[string]any{"vcpu_count": shape.vcpus, "mem_size_mib": shape.memoryMiB}
	if shape.hugePages != "" {
		machine["huge_pages"] = shape.hugePages
	}
	requests := []struct {
		path string
		body any
	}{
		{"/boot-source", map[string]any{"kernel_image_path": shape.kernel, "boot_args": shape.bootArgs}},
		{"/machine-config", machine},
		{"/drives/" + rootfsDrive, map[string]any{
			"drive_id": rootfsDrive, "path_on_host": shape.rootfs, "is_root_device": false, "is_read_only": false,
		}},
		{"/drives/" + systemDrive, map[string]any{
			"drive_id": systemDrive, "path_on_host": shape.system, "is_root_device": false, "is_read_only": true,
		}},
		{"/vsock", map[string]any{"guest_cid": guestCID, "uds_path": shape.vsock}},
		{"/network-interfaces/" + ifaceID, map[string]any{
			"iface_id": ifaceID, "host_dev_name": shape.tap, "guest_mac": shape.guestMAC,
		}},
		{"/balloon", map[string]any{
			"amount_mib": 0, "deflate_on_oom": true, "stats_polling_interval_s": 1, "free_page_reporting": true,
		}},
	}
	for _, r := range requests {
		if _, err := fc.send(http.MethodPut, r.path, r.body); err != nil {
			return err
		}
	}
	return nil
}

func (fc *firecracker) setState(state string) error {
	_, err := fc.send(http.MethodPatch, "/vm", map[string]any{"state": state})
	return err
}

// loadSnapshot sends impd's load, paused and with the run's tap and vsock
// socket, from either the File backend or a UFFD handler's socket.
func (fc *firecracker) loadSnapshot(vmstate, backendType, backendPath, tap, vsock string) error {
	_, err := fc.send(http.MethodPut, "/snapshot/load", map[string]any{
		"snapshot_path":     vmstate,
		"mem_backend":       map[string]any{"backend_type": backendType, "backend_path": backendPath},
		"resume_vm":         false,
		"network_overrides": []map[string]any{{"iface_id": ifaceID, "host_dev_name": tap}},
		"vsock_override":    map[string]any{"uds_path": vsock},
	})
	return err
}
