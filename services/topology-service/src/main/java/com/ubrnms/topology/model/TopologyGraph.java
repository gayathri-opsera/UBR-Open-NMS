package com.ubrnms.topology.model;

import lombok.Data;
import java.util.List;

/** Full topology graph response. */
@Data
public class TopologyGraph {
    private List<TopologyNode> nodes;
    private List<TopologyEdge> edges;
    private int nodeCount;
    private int edgeCount;
}
