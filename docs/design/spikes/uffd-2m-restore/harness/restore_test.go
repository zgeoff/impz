package main

import (
	"testing"
	"time"

	"gotest.tools/v3/assert"
)

func TestKillOnFailureKillsWhenTheHandlerFails(t *testing.T) {
	failed := make(chan struct{})
	killed := make(chan struct{})
	stop := killOnFailure(failed, func() { close(killed) })

	close(failed)

	select {
	case <-killed:
	case <-time.After(10 * time.Second):
		t.Fatal("the watch did not kill after the failure")
	}
	stop()
}

func TestKillOnFailureLeavesTheVMWhenTheWatchEndsFirst(t *testing.T) {
	failed := make(chan struct{})
	kills := 0
	stop := killOnFailure(failed, func() { kills++ })

	stop()
	close(failed)

	assert.Equal(t, kills, 0)
}
