const wf = workflow('nplfril1UNTXXGee', 'My workflow 2', { executionOrder: 'v1', binaryMode: 'separate', availableInMCP: true });

export default wf
  .add(sticky('Check for case information\n\nIf no case information, extract:\n- plaintiffs\n- case name\n- defense address\n- defense counsel, etc.\n- additional local modification here\n', [], { name: 'Sticky Note', height: 176, position: [-352, -144] }))