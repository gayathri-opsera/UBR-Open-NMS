package com.ubrnms.kpi.model;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/** Min/max/avg statistics for a single KPI metric. */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class MetricStats {
    private double min;
    private double max;
    private double avg;
    private int count;
    private double sum;

    public void add(double value) {
        if (count == 0) {
            min = max = value;
        } else {
            if (value < min) min = value;
            if (value > max) max = value;
        }
        sum += value;
        count++;
        avg = sum / count;
    }
}
