package main

import (
	"strings"
	"testing"

	"gotest.tools/v3/assert"
)

func TestMedianTakesTheMiddleOfAnOddCount(t *testing.T) {
	assert.Equal(t, median([]float64{9, 1, 5}), 5.0)
}

func TestMedianAveragesTheMiddlePairOfAnEvenCount(t *testing.T) {
	assert.Equal(t, median([]float64{4, 1, 9, 2}), 3.0)
}

func TestUnionPagesKeepsEachPageOnceInOrder(t *testing.T) {
	assert.DeepEqual(t, unionPages([]int64{4, 0}, []int64{2, 4}), []int64{0, 2, 4})
}

func TestCountFreeHugeBlocksCountsOrdersNineAndTen(t *testing.T) {
	buddyinfo := "Node 0, zone    DMA32   9469  10102   6933  11651   6507   3160   1208    391    101     58     17 \n" +
		"Node 0, zone   Normal  55447  52624  34045  31871  17093   8470   3649   1409    415    189     13 \n"

	assert.Equal(t, countFreeHugeBlocks(buddyinfo), 58+2*17+189+2*13)
}

func TestFormatSummaryGivesEachModesMedians(t *testing.T) {
	results := strings.NewReader(strings.Join([]string{
		`{"label":"file","run":0,"marks":{"spawn":2,"load":30,"resume":1,"parked":15,"disk":0,"patch":0.5,"claim":18,"agent":140,"version":0.5},"hugepages_surp":0}`,
		`{"label":"uffd-fill","run":0,"marks":{"spawn":2,"load":60,"resume":1,"parked":9,"disk":0,"patch":0.4,"claim":5,"agent":56,"version":0.4},"fill":{"pages":20,"ms":25},"faults":{"page_size":2097152,"by_phase":{"load":0,"resumed":1,"claimed":3,"agent":0},"service_p50_us":200,"service_sum_ms":1}}`,
		`{"label":"file","run":1,"marks":{"spawn":2,"load":32,"resume":1,"parked":17,"disk":0,"patch":0.5,"claim":20,"agent":160,"version":0.5},"hugepages_surp":0}`,
		`{"label":"uffd-fill","run":1,"marks":{"spawn":2,"load":64,"resume":1,"parked":11,"disk":0,"patch":0.4,"claim":7,"agent":60,"version":0.4},"fill":{"pages":20,"ms":27},"faults":{"page_size":2097152,"by_phase":{"load":0,"resumed":3,"claimed":5,"agent":0},"service_p50_us":220,"service_sum_ms":2}}`,
	}, "\n"))

	summaries, err := summarise(results)

	assert.NilError(t, err)
	assert.Equal(t, formatSummary(summaries), `| mode | runs | spawn | load | resume | parked | disk | patch | claim | agent | version | faults load/resumed/claimed | fill ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| file | 2 | 2.0 | 31.0 | 1.0 | 16.0 | 0.0 | 0.5 | 19.0 | 150.0 | 0.5 | | |
| uffd-fill | 2 | 2.0 | 62.0 | 1.0 | 10.0 | 0.0 | 0.4 | 6.0 | 58.0 | 0.4 | 0/2/4 | 26.0 |
`)
}
