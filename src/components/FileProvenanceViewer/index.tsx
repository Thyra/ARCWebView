import { useState, useEffect, useId, useRef } from 'react';
import mermaid from '../../util/mermaid';
import { Table, DataTable, type UniqueRow, type Column } from '@primer/react/experimental';
import { JsonController, ROCrate } from '@nfdi4plants/arctrl';
import type { TreeNode } from '../../util/types';

// Types
interface ProvenanceNode {
  id: string;
  label: string;
  type: string;
  metadata: Record<string, string>;
}

interface ProvenanceEdge {
  from: string;
  to: string;
  label: string;
  metadata: Record<string, string>;
}

interface ProvenanceGraph {
  nodes: ProvenanceNode[];
  edges: ProvenanceEdge[];
}

type LDGraph = ReturnType<typeof JsonController.LDGraph.fromROCrateJsonString>;
type LDContext = Parameters<typeof ROCrate.LDLabProcess.validate>[1];
type LDNode = Parameters<typeof ROCrate.LDLabProcess.validate>[0];

// Helper functions
function resolveOption<T>(opt: any, defaultValue: T): T {
  return opt != null ? opt as T : defaultValue;
}

function getAllProcesses(ldGraph: LDGraph, context: LDContext): LDNode[] {
  return ldGraph.Nodes.filter(
    node => ROCrate.LDLabProcess.validate(node, context)
  );
}

function extractNodeMetadata(node: LDNode, ldGraph: LDGraph, context: LDContext): Record<string, string> {
  const metadata: Record<string, string> = {};

  try {
    if (node.SchemaType && node.SchemaType[0] === "Sample") {
      const props = ROCrate.LDSample.getAdditionalProperties(node, ldGraph, context);
      props.forEach((s) => {
        const name = ROCrate.LDPropertyValue.getNameAsString(s, context);
        const value = resolveOption(ROCrate.LDPropertyValue.tryGetValueAsString(s, context), "");
        metadata[name] = value;
      });
    } else if (node.SchemaType && node.SchemaType[0] === "LabProcess") {
      const params = ROCrate.LDLabProcess.getParameterValues(node, ldGraph, context);
      params.forEach((s) => {
        const name = ROCrate.LDPropertyValue.getNameAsString(s, context);
        const value = resolveOption(ROCrate.LDPropertyValue.tryGetValueAsString(s, context), "");
        metadata[name] = value;
      });
    }
  } catch (error) {
    console.error("Error extracting node metadata:", node, error);
  }

  return metadata;
}

function filterToSubgraph(graph: ProvenanceGraph, targetNodeId: string): ProvenanceGraph {
  const reachableNodes = new Set<string>();
  const reachableEdges: ProvenanceEdge[] = [];

  // BFS backwards from target to find all nodes that lead to it
  const queue = [targetNodeId];
  reachableNodes.add(targetNodeId);

  while (queue.length > 0) {
    const current = queue.shift()!;

    // Find all edges that have current as target
    const incomingEdges = graph.edges.filter(e => e.to === current);

    incomingEdges.forEach(edge => {
      reachableEdges.push(edge);
      if (!reachableNodes.has(edge.from)) {
        reachableNodes.add(edge.from);
        queue.push(edge.from);
      }
    });
  }

  // Filter nodes to only those that are reachable
  const filteredNodes = graph.nodes.filter(node => reachableNodes.has(node.id));

  return {
    nodes: filteredNodes,
    edges: reachableEdges,
  };
}

function extractProvenance(ldGraph: LDGraph): ProvenanceGraph | null {
  try {
    const context = ldGraph.TryGetContext();

    if (!context) {
      console.error("No context found in LDGraph");
      return null;
    }

    const nodes: ProvenanceNode[] = [];
    const edges: ProvenanceEdge[] = [];
    const nodeMap: Record<string, ProvenanceNode> = {};

    const processes = getAllProcesses(ldGraph, context as LDContext);

    const addNodeIfMissing = (node: LDNode) => {
      if (!nodeMap[node.id]) {
        const provNode: ProvenanceNode = {
          id: node.id,
          label: node.id,
          type: node.AdditionalType?.[0] || node.SchemaType?.[0] || "Unknown",
          metadata: extractNodeMetadata(node, ldGraph, context as LDContext),
        };
        nodeMap[node.id] = provNode;
        nodes.push(provNode);
      }
    };

    processes.forEach((process) => {
      const inputs = ROCrate.LDLabProcess.getObjects(process, ldGraph, context as LDContext);
      const outputs = ROCrate.LDLabProcess.getResults(process, ldGraph, context as LDContext);

      if (inputs.length === 0 || outputs.length === 0) return;

      let processLabel = process.id;
      const protocol = ROCrate.LDLabProcess.tryGetExecutesLabProtocol(process, ldGraph, context as LDContext);
      if (protocol) {
        processLabel = resolveOption(
          ROCrate.LDLabProtocol.tryGetNameAsString(protocol as LDNode, context as LDContext),
          (protocol as LDNode).id
        );
      }
      const processMetadata = extractNodeMetadata(process, ldGraph, context as LDContext);

      inputs.forEach(addNodeIfMissing);
      outputs.forEach(addNodeIfMissing);

      // In ARC data, processes are flattened to 1:1, but the ROCrate spec
      // permits input/output arrays — emit an edge for every input×output pair.
      inputs.forEach((input) => {
        outputs.forEach((output) => {
          edges.push({
            from: input.id,
            to: output.id,
            label: processLabel,
            metadata: processMetadata,
          });
        });
      });
    });

    return { nodes, edges };
  } catch (error) {
    console.error("Error extracting provenance:", error);
    return null;
  }
}

function getNodeColor(type: string): string {
  if (type.includes("Sample")) return "#8957e5";
  if (type.includes("LabProcess")) return "#1f6feb";
  if (type.includes("File")) return "#238636";
  if (type.includes("Source")) return "#d29922";
  return "#424242";
}

function escapeMermaidLabel(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '&#124;')
    .replace(/[\r\n]+/g, ' ');
}

function generateMermaidDiagram(graph: ProvenanceGraph): string {
  const nodes = graph.nodes.map((node) => {
    const safeId = node.id.replace(/[^\w-]/g, '_');
    const typeClass = node.type.replace(/[^\w-]/g, '_').toLowerCase() || 'unknown';
    const cleanLabel = node.label.replace(/^#(Source_|Sample_)/, '');
    return `${safeId}["${escapeMermaidLabel(cleanLabel)}<br/><sub>${escapeMermaidLabel(node.type)}</sub>"]:::${typeClass}`;
  }).join('\n    ');

  const edges = graph.edges.map((edge) => {
    const fromId = edge.from.replace(/[^\w-]/g, '_');
    const toId = edge.to.replace(/[^\w-]/g, '_');
    return `${fromId} -->|"${escapeMermaidLabel(edge.label)}"| ${toId}`;
  }).join('\n    ');

  const classDefinitions = `
    classDef sample fill:#8957e5,stroke:#6f42c1,stroke-width:2px,color:#fff,font-size:12px,padding:8px
    classDef labprocess fill:#1f6feb,stroke:#0969da,stroke-width:2px,color:#fff,font-size:12px,padding:8px
    classDef file fill:#238636,stroke:#1a7f0e,stroke-width:2px,color:#fff,font-size:12px,padding:8px
    classDef source fill:#d29922,stroke:#b8860b,stroke-width:2px,color:#000,font-size:12px,padding:8px
    classDef unknown fill:#424242,stroke:#222,stroke-width:2px,color:#fff,font-size:12px,padding:8px`;

  return `flowchart TD
    ${nodes}
    ${edges}
    ${classDefinitions}`;
}

interface FileProvenanceViewerProps {
  fileNode?: TreeNode;
  onClose?: () => void;
  ldGraph?: LDGraph;
}

export default function FileProvenanceViewer({
  fileNode,
  onClose,
  ldGraph
}: FileProvenanceViewerProps) {
  const fileName = fileNode?.name || 'output.fastq';
  const [activeTab, setActiveTab] = useState<'diagram' | 'details'>('diagram');
  const [svgContent, setSvgContent] = useState<string>('');
  const [provenance, setProvenance] = useState<ProvenanceGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mermaidRef = useRef<HTMLDivElement>(null);
  const renderId = `provenance-${useId().replace(/[^\w-]/g, '')}`;

  useEffect(() => {
    if (!ldGraph) {
      setError("No ARC data provided");
      return;
    }

    const extracted = extractProvenance(ldGraph);
    if (!extracted) {
      setError("Failed to extract provenance from ARC data");
      return;
    }

    // Look for target node by exact id match
    const targetNode = extracted.nodes.find(node => node.id === fileNode?.id);

    if (!targetNode) {
      setError(`No provenance data available for this file`);
      setProvenance(null);
      return;
    }

    // Filter to subgraph leading to target
    const filteredProvenance = filterToSubgraph(extracted, targetNode.id);
    setProvenance(filteredProvenance);
    setError(null);
  }, [ldGraph, fileNode?.id]);

  useEffect(() => {
    if (!provenance) return;

    const renderDiagram = async () => {
      try {
        const mermaidCode = generateMermaidDiagram(provenance);
        const { svg } = await mermaid.render(renderId, mermaidCode);
        setSvgContent(svg);
      } catch (error) {
        console.error('Error rendering Mermaid diagram:', error);
        setError("Failed to render diagram");
      }
    };
    renderDiagram();
  }, [provenance, renderId]);

  if (error || !provenance) {
    return (
      <div
        style={{
          backgroundColor: 'white',
          borderRadius: '8px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
          maxWidth: '1000px',
          maxHeight: '90vh',
          padding: '24px',
          textAlign: 'center',
        }}
      >
        <h2 style={{ margin: '0 0 12px 0' }}>No Provenance Available</h2>
        <p style={{ margin: 0, color: '#666' }}>
          {error || "Could not load provenance data for this file."}
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        backgroundColor: 'white',
        borderRadius: '8px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
        maxWidth: '1000px',
        maxHeight: '90vh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #e1e4e8', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: '0 0 2px 0', fontSize: '1.3em' }}>File Provenance</h2>
          <p style={{ margin: 0, fontSize: '0.85em', color: '#666' }}>{fileName}</p>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '1.5em',
              cursor: 'pointer',
              color: '#666',
              padding: '0',
              width: '32px',
              height: '32px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ✕
          </button>
        )}
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid #e1e4e8' }}>
        <button
          onClick={() => setActiveTab('diagram')}
          style={{
            background: 'none',
            border: 'none',
            padding: '8px 16px',
            cursor: 'pointer',
            fontSize: '0.95em',
            fontWeight: activeTab === 'diagram' ? '600' : '400',
            color: activeTab === 'diagram' ? '#0969da' : '#666',
            borderBottom: activeTab === 'diagram' ? '2px solid #0969da' : 'none',
            marginBottom: '-1px',
          }}
        >
          Provenance
        </button>
        <button
          onClick={() => setActiveTab('details')}
          style={{
            background: 'none',
            border: 'none',
            padding: '8px 16px',
            cursor: 'pointer',
            fontSize: '0.95em',
            fontWeight: activeTab === 'details' ? '600' : '400',
            color: activeTab === 'details' ? '#0969da' : '#666',
            borderBottom: activeTab === 'details' ? '2px solid #0969da' : 'none',
            marginBottom: '-1px',
          }}
        >
          Details
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: activeTab === 'diagram' ? 'block' : 'none' }}>
        <div
          ref={mermaidRef}
          dangerouslySetInnerHTML={{ __html: svgContent }}
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'flex-start',
            width: '100%',
          }}
        />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '12px', display: activeTab === 'details' ? 'block' : 'none', fontSize: '0.9em' }}>
        <div>
          <h3 style={{ margin: '0 0 8px 0', fontSize: '1em', borderBottom: '2px solid #e1e4e8', paddingBottom: '4px' }}>Nodes</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {provenance.nodes.map((node) => {
              const metadataColumns: Column<UniqueRow>[] = ['Property', 'Value'].map((header) => ({
                header,
                field: header as any,
              }));

              const metadataRows = node.metadata
                ? Object.entries(node.metadata).map(([key, value], idx) => ({
                    id: String(idx),
                    Property: key,
                    Value: value,
                  }))
                : [];

              return (
                <div key={node.id} style={{ padding: '8px', backgroundColor: '#f6f8fa', borderRadius: '4px', border: `1px solid ${getNodeColor(node.type)}33` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                    <div
                      style={{
                        width: '10px',
                        height: '10px',
                        borderRadius: '50%',
                        backgroundColor: getNodeColor(node.type),
                      }}
                    />
                    <span style={{ fontWeight: '600' }}>{node.label}</span>
                    <span style={{ fontSize: '0.8em', color: '#666', backgroundColor: '#e8eef2', padding: '1px 4px', borderRadius: '3px' }}>
                      {node.type}
                    </span>
                  </div>
                  {metadataRows.length > 0 && (
                    <Table.Container>
                      <DataTable
                        data={metadataRows}
                        columns={metadataColumns}
                        cellPadding="condensed"
                      />
                    </Table.Container>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ marginTop: '16px' }}>
          <h3 style={{ margin: '0 0 8px 0', fontSize: '1em', borderBottom: '2px solid #e1e4e8', paddingBottom: '4px' }}>Transformations</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {provenance.edges.map((edge, idx) => {
              const fromNode = provenance.nodes.find((n) => n.id === edge.from);
              const toNode = provenance.nodes.find((n) => n.id === edge.to);

              const metadataColumns: Column<UniqueRow>[] = ['Property', 'Value'].map((header) => ({
                header,
                field: header as any,
              }));

              const metadataRows = edge.metadata
                ? Object.entries(edge.metadata).map(([key, value], i) => ({
                    id: String(i),
                    Property: key,
                    Value: value,
                  }))
                : [];

              return (
                <div key={idx} style={{ padding: '8px', backgroundColor: '#f6f8fa', borderRadius: '4px', border: '1px solid #ddf4ff' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px', fontSize: '0.9em' }}>
                    <span style={{ fontWeight: '600' }}>{fromNode?.label}</span>
                    <span style={{ color: '#666' }}>→</span>
                    <span style={{ fontWeight: '600' }}>{toNode?.label}</span>
                  </div>
                  {edge.label && (
                    <div style={{ marginBottom: '8px', padding: '4px 6px', backgroundColor: '#ddf4ff', color: '#0969da', borderRadius: '3px', fontSize: '0.85em', fontWeight: '600' }}>
                      {edge.label}
                    </div>
                  )}
                  {metadataRows.length > 0 && (
                    <Table.Container>
                      <DataTable
                        data={metadataRows}
                        columns={metadataColumns}
                        cellPadding="condensed"
                      />
                    </Table.Container>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
