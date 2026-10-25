undef $/;
$_ = <STDIN>;
s/runWithStack\(async \(stack\) => \{\n(\s+)const governorSleeps/runWithStack(async (stack) => {\n$1const probeRunStart = performance.now();\n$1stack.defer(() => { console.log(`PROBE run \${performance.now() - probeRunStart}`); });\n$1const governorSleeps/ or die "no run anchor";
s/(\n\s+)const ctx = await startTestImpd\(stack, \{\n(\s+)env: \{\n(\s+)IMP_RAM_BUDGET_MIB: '900'/$1const probeBootStart = performance.now();$1const ctx = await startTestImpd(stack, {\n$2env: {\n$3IMP_RAM_BUDGET_MIB: '900'/ or die "no boot anchor";
s/(\n\s+)holder\.db = ctx\.db;/$1console.log(`PROBE boot \${performance.now() - probeBootStart}`);$1holder.db = ctx.db;/ or die "no db anchor";
print;
