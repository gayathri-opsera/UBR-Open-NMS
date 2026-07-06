package com.ubrnms.kpiquery.model;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.io.Serializable;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class MetricStats implements Serializable {
    private double min;
    private double max;
    private double avg;
    private int count;
    private double sum;
}
