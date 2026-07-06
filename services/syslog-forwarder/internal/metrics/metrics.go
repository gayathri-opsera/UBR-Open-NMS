package metrics

import "github.com/prometheus/client_golang/prometheus"

var (
	ForwardedTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "syslog_events_forwarded_total",
		Help: "Total number of operational events successfully forwarded to syslog",
	})
	BufferDepth = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "syslog_buffer_depth",
		Help: "Number of events currently buffered awaiting syslog endpoint reconnection",
	})
	ErrorsTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "syslog_forward_errors_total",
		Help: "Total number of forwarding errors (parse failures + send failures)",
	})
)

// Register registers all metrics with the default Prometheus registry.
func Register() {
	prometheus.MustRegister(ForwardedTotal, BufferDepth, ErrorsTotal)
}
