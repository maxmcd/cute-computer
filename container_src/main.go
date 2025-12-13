package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func runS3Operations(ctx context.Context, s3Client *s3.Client, bucketName string) (data map[string]interface{}, err error) {
	key := "test.txt"
	value := []byte("test")

	_, err = s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: &bucketName,
		Key:    &key,
		Body:   bytes.NewReader(value),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to put object: %w", err)
	}

	listResult, err := s3Client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
		Bucket: &bucketName,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to list objects: %w", err)
	}

	getResult, err := s3Client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: &bucketName,
		Key:    &key,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to read object: %w", err)
	}
	defer getResult.Body.Close()

	bytes, err := io.ReadAll(getResult.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read object: %w", err)
	}

	return map[string]interface{}{
		"write": key,
		"list":  len(listResult.Contents),
		"read":  string(bytes),
	}, nil

}

// asdf
func handler(s3Client *s3.Client, bucketName string) func(w http.ResponseWriter, r *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		data, err := runS3Operations(ctx, s3Client, bucketName)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(data)
	}
}

func main() {
	endpoint := "http://host.docker.internal:8787"
	region := "us-east-1"

	awsCfg, err := config.LoadDefaultConfig(context.TODO(),
		config.WithRegion(region),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
			"foo",
			"bar",
			"",
		)),
	)
	if err != nil {
		panic(err)
	}

	// 2) S3 client pointed at MinIO + path-style
	s3Client := s3.NewFromConfig(awsCfg,
		s3.WithEndpointResolver(s3.EndpointResolverFromURL(endpoint)),
		func(o *s3.Options) {
			o.UsePathStyle = true
		},
	)

	bucketName := "foo"

	// Listen for SIGINT and SIGTERM
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	router := http.NewServeMux()
	router.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("/"))
	})
	router.HandleFunc("/____container", handler(s3Client, bucketName))

	server := &http.Server{
		Addr:    ":8080",
		Handler: router,
	}

	go func() {
		log.Printf("Server listening on %s\n", server.Addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	// Wait to receive a signal
	sig := <-stop

	log.Printf("Received signal (%s), shutting down server...", sig)

	// Give the server 5 seconds to shutdown
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Fatal(err)
	}

	log.Println("Server shutdown successfully")
}
