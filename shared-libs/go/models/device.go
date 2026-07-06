// Package models provides canonical data model structs for the UBR NMS.
package models

import "time"

type DeviceType string
type DeviceStatus string

const (
	DeviceTypeBTS DeviceType = "BTS"
	DeviceTypeCPE DeviceType = "CPE"
	DeviceTypeIDU DeviceType = "IDU"

	DeviceStatusOnline        DeviceStatus = "online"
	DeviceStatusOffline       DeviceStatus = "offline"
	DeviceStatusProvisioning  DeviceStatus = "provisioning"
	DeviceStatusDecommissioned DeviceStatus = "decommissioned"
)

type DeviceTag struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type DeviceEntity struct {
	DeviceID           string       `json:"deviceId"`
	SerialNumber       string       `json:"serialNumber"`
	MacAddress         string       `json:"macAddress"`
	IPAddress          string       `json:"ipAddress,omitempty"`
	DeviceType         DeviceType   `json:"deviceType"`
	Model              string       `json:"model,omitempty"`
	FirmwareVersion    string       `json:"firmwareVersion,omitempty"`
	Region             string       `json:"region,omitempty"`
	Latitude           float64      `json:"latitude,omitempty"`
	Longitude          float64      `json:"longitude,omitempty"`
	Elevation          float64      `json:"elevation,omitempty"`
	Azimuth            int          `json:"azimuth,omitempty"`
	Tilt               int          `json:"tilt,omitempty"`
	Status             DeviceStatus `json:"status"`
	UptimeSeconds      int64        `json:"uptimeSeconds,omitempty"`
	ConnectedBTSSerial *string      `json:"connectedBtsSerial"`
	ConnectedCPECount  int          `json:"connectedCpeCount,omitempty"`
	ConnectedIDUCount  int          `json:"connectedIduCount,omitempty"`
	Tags               []DeviceTag  `json:"tags,omitempty"`
	OrganizationID     string       `json:"organizationId,omitempty"`
	NetworkID          string       `json:"networkId,omitempty"`
	CreatedAt          time.Time    `json:"createdAt,omitempty"`
	UpdatedAt          time.Time    `json:"updatedAt,omitempty"`
}
